"""Google OAuth bearer validation for the MCP endpoint.

Mirrors the shape of `app.auth.cloudflare.verify_access_jwt`: returns a dict
of claims on success, raises a typed `GoogleOAuthError` on any failure. The
MCP middleware catches that and converts to HTTP 401.

Two token shapes are accepted because Claude/ChatGPT may send either:

- **ID token** (JWT, RS256) — verified offline against Google's JWKS via
  `google-auth`. Audience must equal our OAuth client_id.
- **Access token** (opaque) — verified online via Google's `/tokeninfo`
  endpoint (which also returns the audience), then userinfo fetched from
  `/oauth2/v2/userinfo`.

The access-token path matches the pattern already used by
`app.auth.google.get_google_user_info` for the web sign-in flow; see that
file for the security rationale of the audience check.
"""
from __future__ import annotations

import httpx
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token

from app.config import get_settings

settings = get_settings()


class GoogleOAuthError(Exception):
    """Raised for any failure to validate a Google OAuth bearer token."""


def _looks_like_jwt(token: str) -> bool:
    """A JWT has three base64 segments separated by dots. Access tokens
    issued by Google are opaque strings without that structure."""
    return token.count(".") == 2 and all(token.split("."))


def verify_google_oauth_bearer(token: str) -> dict:
    """Validate a Google ID or access token. Return claims dict with
    `email` and `sub`. Raise `GoogleOAuthError` on any failure.
    """
    token = (token or "").strip()
    if not token:
        raise GoogleOAuthError("empty bearer token")
    if not settings.google_client_id:
        raise GoogleOAuthError("server is missing google_client_id configuration")

    if _looks_like_jwt(token):
        try:
            idinfo = id_token.verify_oauth2_token(
                token, google_requests.Request(), settings.google_client_id
            )
        except Exception as exc:
            raise GoogleOAuthError(f"ID token verification failed: {exc}") from exc
        if idinfo.get("iss") not in (
            "accounts.google.com",
            "https://accounts.google.com",
        ):
            raise GoogleOAuthError(f"unexpected issuer: {idinfo.get('iss')}")
        email = idinfo.get("email")
        if not email:
            raise GoogleOAuthError("ID token missing email claim")
        return {"email": email, "sub": idinfo.get("sub"), "email_verified": idinfo.get("email_verified")}

    try:
        with httpx.Client(timeout=10.0) as client:
            ti = client.get(
                "https://oauth2.googleapis.com/tokeninfo",
                params={"access_token": token},
            )
            if ti.status_code != 200:
                raise GoogleOAuthError(
                    f"tokeninfo rejected token (status={ti.status_code})"
                )
            info = ti.json()
            aud = info.get("aud") or info.get("audience")
            if aud != settings.google_client_id:
                raise GoogleOAuthError(
                    f"access token audience mismatch (got {aud!r})"
                )
            if int(info.get("expires_in", 0) or 0) <= 0:
                raise GoogleOAuthError("access token expired")

            ui = client.get(
                "https://www.googleapis.com/oauth2/v2/userinfo",
                headers={"Authorization": f"Bearer {token}"},
            )
            if ui.status_code != 200:
                raise GoogleOAuthError(
                    f"userinfo lookup failed (status={ui.status_code})"
                )
            data = ui.json()
            email = data.get("email")
            if not email:
                raise GoogleOAuthError("userinfo response missing email")
            return {"email": email, "sub": data.get("id"), "email_verified": data.get("verified_email")}
    except httpx.HTTPError as exc:
        raise GoogleOAuthError(f"network error validating access token: {exc}") from exc
