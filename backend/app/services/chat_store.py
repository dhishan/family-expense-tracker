"""Firestore-backed durable chat store.

Architecture: the chat router writes every event (text delta, tool_call,
tool_result, status, done, error) to Firestore so generation survives
client disconnects. The client connects via a resumable SSE endpoint
that reads the events array starting from a `from_seq` cursor.

Schema:
  /chat_conversations/{conv_id}
    user_id: str          (owner — enforced on every read)
    family_id: str | null
    title: str            (first user message, truncated)
    created_at, updated_at: timestamp
    last_turn_id: str | null
    turn_count: int

  /chat_conversations/{conv_id}/turns/{turn_id}
    user_id: str          (denormalized for security defense-in-depth)
    conv_id: str          (denormalized)
    seq: int              (sequence within conversation)
    role: "user" | "assistant"
    status: "pending" | "streaming" | "complete" | "error"
    text: str             (final assembled markdown; user text for user turns)
    tool_calls: list[dict]  (id, name, input, status, label, preview)
    error: str | null
    model: str | null
    events: list[dict]    (chunked stream; each {seq, type, ...})
                          Capped at MAX_EVENTS — older events drop off
                          (text is preserved in `text` field).
    created_at, updated_at: timestamp
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from google.cloud import firestore  # type: ignore

from app.services.firestore import get_firestore_client

logger = logging.getLogger(__name__)

# Each event row is small (~200 bytes typical text delta). Cap keeps the
# turn doc under Firestore's 1MB limit even with very long responses.
# When events overflow, older ones are dropped — the `text` field always
# has the full assembled response so resume can still recover the body.
MAX_EVENTS = 800
TITLE_MAX_LEN = 80


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


def _title_from_message(text: str) -> str:
    text = (text or "").strip().replace("\n", " ")
    if len(text) <= TITLE_MAX_LEN:
        return text or "New chat"
    return text[: TITLE_MAX_LEN - 1].rstrip() + "…"


class ChatStore:
    """Thin Firestore wrapper for chat persistence.

    All read methods accept a `user_id` and return None / raise if the
    requested doc doesn't belong to that user. The backend never trusts
    a conv_id from the client without first verifying ownership.
    """

    def __init__(self) -> None:
        self._db = get_firestore_client()
        self._convs = self._db.collection("chat_conversations")

    # ───────────────────────── Conversations ─────────────────────────

    def create_conversation(
        self, *, user_id: str, family_id: str | None, first_message: str
    ) -> str:
        conv_id = _new_id("conv")
        now = _now()
        self._convs.document(conv_id).set(
            {
                "user_id": user_id,
                "family_id": family_id,
                "title": _title_from_message(first_message),
                "created_at": now,
                "updated_at": now,
                "last_turn_id": None,
                "turn_count": 0,
            }
        )
        return conv_id

    def get_conversation(self, conv_id: str, *, user_id: str) -> dict | None:
        """Returns the conversation doc if it belongs to user_id, else None.

        Returning None for foreign convs (vs raising) lets callers decide
        whether to 404 or 403 — the router 404s to avoid leaking existence.
        """
        snap = self._convs.document(conv_id).get()
        if not snap.exists:
            return None
        data = snap.to_dict() or {}
        if data.get("user_id") != user_id:
            logger.warning(
                "Cross-user chat access attempted: requester=%s owner=%s conv=%s",
                user_id,
                data.get("user_id"),
                conv_id,
            )
            return None
        data["id"] = conv_id
        return data

    def list_conversations(self, *, user_id: str, limit: int = 50) -> list[dict]:
        """Most recent conversations for a user, newest first."""
        query = (
            self._convs.where(filter=firestore.FieldFilter("user_id", "==", user_id))
            .order_by("updated_at", direction=firestore.Query.DESCENDING)
            .limit(limit)
        )
        out: list[dict] = []
        for snap in query.stream():
            data = snap.to_dict() or {}
            data["id"] = snap.id
            out.append(data)
        return out

    def delete_conversation(self, conv_id: str, *, user_id: str) -> bool:
        conv = self.get_conversation(conv_id, user_id=user_id)
        if not conv:
            return False
        # Delete turns subcollection in batches.
        turns_ref = self._convs.document(conv_id).collection("turns")
        batch = self._db.batch()
        n = 0
        for snap in turns_ref.stream():
            batch.delete(snap.reference)
            n += 1
            if n % 400 == 0:
                batch.commit()
                batch = self._db.batch()
        batch.delete(self._convs.document(conv_id))
        batch.commit()
        return True

    # ─────────────────────────────── Turns ───────────────────────────

    def _turns(self, conv_id: str):
        return self._convs.document(conv_id).collection("turns")

    def create_user_turn(
        self, *, conv_id: str, user_id: str, text: str, seq: int
    ) -> str:
        turn_id = _new_id("turn")
        now = _now()
        self._turns(conv_id).document(turn_id).set(
            {
                "user_id": user_id,
                "conv_id": conv_id,
                "seq": seq,
                "role": "user",
                "status": "complete",
                "text": text,
                "tool_calls": [],
                "error": None,
                "model": None,
                "events": [
                    {"seq": 0, "type": "text", "text": text, "ts": now.isoformat()}
                ],
                "created_at": now,
                "updated_at": now,
            }
        )
        return turn_id

    def create_assistant_turn(
        self, *, conv_id: str, user_id: str, seq: int, model: str
    ) -> str:
        turn_id = _new_id("turn")
        now = _now()
        self._turns(conv_id).document(turn_id).set(
            {
                "user_id": user_id,
                "conv_id": conv_id,
                "seq": seq,
                "role": "assistant",
                "status": "streaming",
                "text": "",
                "tool_calls": [],
                "error": None,
                "model": model,
                "events": [],
                "created_at": now,
                "updated_at": now,
            }
        )
        return turn_id

    def get_turn(self, conv_id: str, turn_id: str, *, user_id: str) -> dict | None:
        snap = self._turns(conv_id).document(turn_id).get()
        if not snap.exists:
            return None
        data = snap.to_dict() or {}
        if data.get("user_id") != user_id:
            logger.warning(
                "Cross-user turn access attempted: requester=%s owner=%s conv=%s turn=%s",
                user_id,
                data.get("user_id"),
                conv_id,
                turn_id,
            )
            return None
        data["id"] = turn_id
        return data

    def list_turns(self, conv_id: str, *, user_id: str) -> list[dict]:
        # Defense-in-depth: even though the conv-level check below
        # prevents a foreign user from reaching here, each turn doc is
        # double-checked so a single bug in a router can't leak data.
        conv = self.get_conversation(conv_id, user_id=user_id)
        if not conv:
            return []
        out: list[dict] = []
        query = self._turns(conv_id).order_by("seq")
        for snap in query.stream():
            data = snap.to_dict() or {}
            if data.get("user_id") != user_id:
                continue
            data["id"] = snap.id
            out.append(data)
        return out

    # ─────────────────────── Streaming writes ────────────────────────

    def append_event(
        self,
        conv_id: str,
        turn_id: str,
        *,
        event: dict,
        text_delta: str | None = None,
        tool_call: dict | None = None,
    ) -> None:
        """Append a single event to the turn doc. Also updates the running
        `text` and `tool_calls` projections so resume can render without
        replaying every event.

        Concurrency: events are appended with the seq field they carry;
        the generation loop assigns monotonically increasing seq numbers.
        Single writer per turn (the background generator), so no need for
        transactions.
        """
        updates: dict[str, Any] = {
            "events": firestore.ArrayUnion([event]),
            "updated_at": _now(),
        }
        if text_delta:
            # Firestore doesn't have a native string-append; read-modify-write
            # would race with high-frequency text deltas. We accept the cost
            # of writing the running text only on tool boundaries — see
            # `flush_text` below for the periodic batched write.
            pass
        if tool_call:
            updates["tool_calls"] = firestore.ArrayUnion([tool_call])
        self._turns(conv_id).document(turn_id).update(updates)

    def flush_text(self, conv_id: str, turn_id: str, *, full_text: str) -> None:
        """Overwrite the running text projection. Called periodically by the
        generator (every ~500ms) and on completion so resume sees a coherent
        body without iterating all events."""
        self._turns(conv_id).document(turn_id).update(
            {"text": full_text, "updated_at": _now()}
        )

    def finalize_turn(
        self,
        conv_id: str,
        turn_id: str,
        *,
        status: str,
        text: str,
        error: str | None = None,
    ) -> None:
        self._turns(conv_id).document(turn_id).update(
            {
                "status": status,
                "text": text,
                "error": error,
                "updated_at": _now(),
            }
        )
        # Bump conversation's updated_at + last_turn pointer
        self._convs.document(conv_id).update(
            {"updated_at": _now(), "last_turn_id": turn_id}
        )

    def update_conversation_meta(
        self, conv_id: str, *, last_turn_id: str, increment_turn_count: int = 0
    ) -> None:
        updates: dict[str, Any] = {
            "last_turn_id": last_turn_id,
            "updated_at": _now(),
        }
        if increment_turn_count:
            updates["turn_count"] = firestore.Increment(increment_turn_count)
        self._convs.document(conv_id).update(updates)


_store: ChatStore | None = None


def get_chat_store() -> ChatStore:
    global _store
    if _store is None:
        _store = ChatStore()
    return _store
