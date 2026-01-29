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
    
    # JWT Settings
    jwt_algorithm: str = "HS256"
    jwt_expiration_hours: int = 24 * 7  # 7 days
    
    # API Settings
    api_prefix: str = "/api/v1"
    
    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        case_sensitive = False


@lru_cache()
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()
