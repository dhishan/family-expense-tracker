"""Cloudflare Access JWT verification.

Cloudflare Access fronts the hosted /mcp endpoint in production. When a request
arrives, CF Access has already authenticated the user via OAuth (Google), and
injects a signed JWT in the `Cf-Access-Jwt-Assertion` header. This module
verifies that JWT against Cloudflare's public JWKS and returns the verified
claims (most importantly `email`).

Wire-up:
  * Team domain (e.g. `blueelephants.cloudflareaccess.com`) is read from
    settings.cf_access_team_domain.
  * Application AUD tag is read from settings.cf_access_aud.
  * JWKS is fetched from https://{team_domain}/cdn-cgi/access/certs and cached
    in-process for 10 minutes (CF rotates keys infrequently; refresh-on-miss
    handles the rare rotation).
"""
from __future__ import annotations

import logging
import time
from typing import Any

import httpx
from jose import jwt
from jose.exceptions import JWTError

from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

_JWKS_TTL_SECONDS = 600
_jwks_cache: dict[str, Any] = {"fetched_at": 0.0, "keys": None}


class CloudflareAuthError(Exception):
    """Raised when CF Access JWT verification fails."""


def _certs_url() -> str:
    return f"https://{settings.cf_access_team_domain}/cdn-cgi/access/certs"


def _issuer() -> str:
    return f"https://{settings.cf_access_team_domain}"


def _fetch_jwks(force: bool = False) -> dict:
    now = time.time()
    if (
        not force
        and _jwks_cache["keys"] is not None
        and now - _jwks_cache["fetched_at"] < _JWKS_TTL_SECONDS
    ):
        return _jwks_cache["keys"]
    resp = httpx.get(_certs_url(), timeout=5.0)
    resp.raise_for_status()
    jwks = resp.json()
    _jwks_cache["keys"] = jwks
    _jwks_cache["fetched_at"] = now
    return jwks


def verify_access_jwt(token: str) -> dict:
    """Verify a Cloudflare Access JWT. Returns the decoded claims on success.

    Raises CloudflareAuthError on any failure (bad signature, wrong AUD,
    expired, missing kid, etc.).
    """
    if not settings.cf_access_team_domain or not settings.cf_access_aud:
        raise CloudflareAuthError(
            "Cloudflare Access not configured: set CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD."
        )

    try:
        unverified_header = jwt.get_unverified_header(token)
    except JWTError as e:
        raise CloudflareAuthError(f"Malformed JWT header: {e}") from e

    kid = unverified_header.get("kid")
    if not kid:
        raise CloudflareAuthError("JWT header missing 'kid'")

    # Try cached JWKS first; refresh once on kid miss (key rotation).
    for attempt in (False, True):
        jwks = _fetch_jwks(force=attempt)
        key = next((k for k in jwks.get("keys", []) if k.get("kid") == kid), None)
        if key:
            break
    else:
        raise CloudflareAuthError(f"Signing key kid={kid} not found in JWKS")

    try:
        claims = jwt.decode(
            token,
            key,
            algorithms=[unverified_header.get("alg", "RS256")],
            audience=settings.cf_access_aud,
            issuer=_issuer(),
        )
    except JWTError as e:
        raise CloudflareAuthError(f"JWT verification failed: {e}") from e

    return claims
