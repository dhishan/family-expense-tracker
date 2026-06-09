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
    secret_key: str = "change-me-in-production"
    jwt_secret_key: str = ""
    
    # JWT Settings
    jwt_algorithm: str = "HS256"
    jwt_expiration_hours: int = 24 * 7  # 7 days
    
    # API Settings
    api_prefix: str = "/api/v1"

    # SnapTrade (brokerage data aggregator)
    snaptrade_client_id: str = ""
    snaptrade_consumer_key: str = ""

    # Financial data APIs (Phase F)
    fred_api_key: str = ""
    tiingo_api_key: str = ""
    finnhub_api_key: str = ""

    # Cloudflare Access (gates the hosted /mcp endpoint in production)
    cf_access_team_domain: str = ""  # e.g. blueelephants.cloudflareaccess.com
    cf_access_aud: str = ""          # Application AUD tag

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        case_sensitive = False
        extra = "ignore"


@lru_cache()
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()
