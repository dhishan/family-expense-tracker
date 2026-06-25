"""OAuth metadata endpoints for MCP client discovery.

claude.ai and chatgpt.com custom connectors hit these well-known URLs to
discover how to authenticate against the MCP server. We point both at
Google as the authorization server and publish our pre-registered OAuth
client_id so clients can skip dynamic client registration.

Hosted on the root of the FastAPI app (no `/api/v1` prefix) because the
RFC 9728 / RFC 8414 spec mandates the exact `/.well-known/...` paths.
"""
from __future__ import annotations

from fastapi import APIRouter

from app.config import get_settings

router = APIRouter()
settings = get_settings()


def _resource_url() -> str:
    """Public URL of the MCP resource. Override via env if the subdomain
    changes; defaults to the production subdomain."""
    return (
        settings.mcp_public_url
        if getattr(settings, "mcp_public_url", "")
        else "https://mcp.expense-tracker.blueelephants.org/mcp/"
    )


@router.get("/.well-known/oauth-protected-resource", include_in_schema=False)
async def oauth_protected_resource() -> dict:
    return {
        "resource": _resource_url(),
        "authorization_servers": ["https://accounts.google.com"],
        "scopes_supported": ["openid", "email", "profile"],
        "bearer_methods_supported": ["header"],
    }


@router.get("/.well-known/oauth-authorization-server", include_in_schema=False)
async def oauth_authorization_server() -> dict:
    """Trimmed copy of Google's OIDC discovery document with our
    pre-registered client_id added so clients can skip DCR."""
    return {
        "issuer": "https://accounts.google.com",
        "authorization_endpoint": "https://accounts.google.com/o/oauth2/v2/auth",
        "token_endpoint": "https://oauth2.googleapis.com/token",
        "userinfo_endpoint": "https://openidconnect.googleapis.com/v1/userinfo",
        "revocation_endpoint": "https://oauth2.googleapis.com/revoke",
        "jwks_uri": "https://www.googleapis.com/oauth2/v3/certs",
        "response_types_supported": ["code"],
        "subject_types_supported": ["public"],
        "id_token_signing_alg_values_supported": ["RS256"],
        "scopes_supported": ["openid", "email", "profile"],
        "token_endpoint_auth_methods_supported": [
            "client_secret_post",
            "client_secret_basic",
        ],
        "claims_supported": ["sub", "email", "email_verified", "name", "picture"],
        "code_challenge_methods_supported": ["S256"],
        "client_id": settings.google_client_id,
    }
