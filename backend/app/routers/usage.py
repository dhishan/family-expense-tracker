"""Usage / cost metering router.

Powers the cost chip in the chat header (session + monthly).
Single-doc Firestore reads — no aggregations.
"""
from fastapi import APIRouter, Depends, Query

from app.auth.dependencies import get_current_user
from app.models.user import User
from app.services import usage_service

router = APIRouter()


@router.get("/quick")
async def usage_quick(
    conversation_id: str | None = Query(None),
    current_user: User = Depends(get_current_user),
):
    """Return session + month cost for the calling user.

    - session_cost_usd: cost accumulated on the given conversation (0.0 if absent)
    - month_cost_usd:   total cost for the current calendar month
    """
    session_cost = (
        usage_service.get_conversation_cost(conversation_id)
        if conversation_id
        else 0.0
    )
    month_cost = usage_service.get_monthly_cost(current_user.id)
    return {
        "session_cost_usd": session_cost,
        "month_cost_usd": month_cost,
    }
