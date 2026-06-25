"""Application configuration."""
from functools import lru_cache
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""
    
    # GCP Configuration
    gcp_project_id: str = "personal-projects-473219"
    firestore_database: str = "family-expense-tracker-dev"
    
    # Google OAuth
    google_client_id: str = ""
    google_client_secret: str = ""
    
    # Application Settings
    environment: str = "development"
    frontend_url: str = "http://localhost:5173"
    # NOTE: JWT signing uses `effective_jwt_secret()` below — prefer
    # `jwt_secret_key` (what Terraform injects as JWT_SECRET_KEY in prod),
    # fall back to `secret_key` for legacy / local dev.
    secret_key: str = "change-me-in-production"
    jwt_secret_key: str = ""

    # JWT Settings
    jwt_algorithm: str = "HS256"
    jwt_expiration_hours: int = 24  # 24h; was 7 days — narrows the
    # window an exfiltrated localStorage JWT stays usable. See task #50.

    # Hard-coded default we MUST refuse to start with in production.
    _DEFAULT_SECRET_KEY: str = "change-me-in-production"

    def effective_jwt_secret(self) -> str:
        """Single source of truth for JWT signing/verifying.

        Prefer `JWT_SECRET_KEY` (what Terraform injects in prod). Fall back
        to `SECRET_KEY` for local dev and pre-fix deployments. Return ""
        if neither is set so callers can fail closed.
        """
        return (self.jwt_secret_key or self.secret_key or "").strip()
    
    # API Settings
    api_prefix: str = "/api/v1"

    # SnapTrade (brokerage data aggregator)
    snaptrade_client_id: str = ""
    snaptrade_consumer_key: str = ""

    # Plaid (bank account linking + transaction sync)
    plaid_client_id: str = ""
    plaid_secret: str = ""
    plaid_env: str = "sandbox"  # sandbox | development | production

    # Financial data APIs (Phase F)
    fred_api_key: str = ""
    tiingo_api_key: str = ""
    finnhub_api_key: str = ""

    # Kalshi (CFTC-regulated prediction market) — RSA-PSS signing
    kalshi_key_id: str = ""
    kalshi_private_key_b64: str = ""

    # Alpaca (options data, market quotes, OHLCV bars)
    apca_api_key_id: str = ""
    apca_api_secret_key: str = ""

    # Tradier (options chains with real Greeks; brokerage data API).
    # In prod: TRADIER_TOKEN + TRADIER_ENV=production → api.tradier.com
    # In CI:   TRADIER_TOKEN_SANDBOX                  → sandbox.tradier.com
    tradier_token: str = ""
    tradier_env: str = "sandbox"  # sandbox | production
    tradier_token_sandbox: str = ""           # used by CI / smoke tests
    tradier_env_sandbox_account: str = ""     # sandbox account id (only needed for /accounts endpoints)

    # Cloudflare Access (legacy — MCP no longer gated by CF Access; auth is
    # Google OAuth bearer at the application layer). Kept for any other
    # future use; unused by mcp_server.py as of the OAuth migration.
    cf_access_team_domain: str = ""  # e.g. blueelephants.cloudflareaccess.com
    cf_access_aud: str = ""          # Application AUD tag

    # Public URL of the MCP endpoint, used in OAuth metadata responses and
    # the WWW-Authenticate challenge. Override in local dev to point at
    # http://localhost:8000/mcp/ if needed.
    mcp_public_url: str = "https://mcp.expense-tracker.blueelephants.org/mcp/"

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        case_sensitive = False
        extra = "ignore"


@lru_cache()
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()
