"""MCP auth surface — Google OAuth bearer + well-known discovery."""
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.auth.google_oauth import GoogleOAuthError


@pytest.fixture
def client():
    return TestClient(app)


def test_wellknown_oauth_protected_resource_shape(client):
    r = client.get("/.well-known/oauth-protected-resource")
    assert r.status_code == 200
    body = r.json()
    assert set(body) >= {
        "resource",
        "authorization_servers",
        "scopes_supported",
        "bearer_methods_supported",
    }
    assert body["authorization_servers"] == ["https://accounts.google.com"]
    assert body["bearer_methods_supported"] == ["header"]
    assert body["resource"].startswith("https://")
    assert body["resource"].endswith("/mcp/")


def test_wellknown_oauth_authorization_server_advertises_client_id(client):
    r = client.get("/.well-known/oauth-authorization-server")
    assert r.status_code == 200
    body = r.json()
    assert body["issuer"] == "https://accounts.google.com"
    assert body["authorization_endpoint"].startswith("https://accounts.google.com/")
    assert body["token_endpoint"].startswith("https://oauth2.googleapis.com/")
    assert "client_id" in body
    assert body["client_id"] == "test-client-id"
    assert "registration_endpoint" not in body


def test_mcp_unauth_returns_401_with_www_authenticate(client):
    r = client.get("/mcp/")
    assert r.status_code == 401
    challenge = r.headers.get("www-authenticate", "")
    assert challenge.startswith("Bearer ")
    assert "resource_metadata=" in challenge
    assert "/.well-known/oauth-protected-resource" in challenge


def test_mcp_cf_access_header_alone_no_longer_accepted(client):
    """Backwards-incompatibility check: the old CF Access JWT path was removed."""
    r = client.get("/mcp/", headers={"cf-access-jwt-assertion": "anything"})
    assert r.status_code == 401


def test_mcp_google_bearer_unknown_email_returns_403(client):
    fake_claims = {"email": "stranger@example.com", "sub": "g-99", "email_verified": True}
    with patch(
        "app.mcp_server.verify_google_oauth_bearer", return_value=fake_claims
    ), patch("app.mcp_server.get_firestore_client") as fs:
        db = MagicMock()
        db.collection.return_value.where.return_value.limit.return_value.stream.return_value = iter(
            []
        )
        fs.return_value = db
        r = client.get("/mcp/", headers={"Authorization": "Bearer fake-google-token"})
    assert r.status_code == 403
    assert "stranger@example.com" in r.json()["error"]


def test_mcp_google_bearer_invalid_token_returns_401(client):
    with patch(
        "app.mcp_server.verify_google_oauth_bearer",
        side_effect=GoogleOAuthError("expired"),
    ):
        r = client.get("/mcp/", headers={"Authorization": "Bearer bad-token"})
    assert r.status_code == 401
    assert "Google OAuth bearer invalid" in r.json()["error"]


def test_mcp_unverified_email_rejected_before_lookup(client):
    """SECURITY: unverified email must NOT resolve to an existing account, even
    if it matches one. Otherwise a forged/unverified claim could impersonate."""
    unverified = {"email": "victim@example.com", "sub": "attacker", "email_verified": False}
    with (
        patch("app.mcp_server.verify_google_oauth_bearer", return_value=unverified),
        patch("app.mcp_server.get_firestore_client") as fs,
    ):
        db = MagicMock()
        fs.return_value = db
        r = client.get("/mcp/", headers={"Authorization": "Bearer t"})
    assert r.status_code == 401
    assert "not verified" in r.json()["error"]
    # The lookup helper must not have been touched.
    db.collection.assert_not_called()
