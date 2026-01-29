"""Firestore database client."""
from functools import lru_cache
from google.cloud import firestore
import os

from app.config import get_settings

settings = get_settings()

_db_client = None


def get_firestore_client() -> firestore.Client:
    """
    Get a Firestore client instance.
    
    Uses a singleton pattern to reuse the client across requests.
    Will use Application Default Credentials (ADC) when available.
    
    Returns:
        Firestore client
    """
    global _db_client
    
    if _db_client is None:
        # Use Application Default Credentials (works both locally and in Cloud Run)
        _db_client = firestore.Client(
            project=settings.gcp_project_id,
            database=settings.firestore_database,
        )
    
    return _db_client
    
    return _db_client


def get_server_timestamp() -> firestore.SERVER_TIMESTAMP:
    """Get Firestore server timestamp."""
    return firestore.SERVER_TIMESTAMP
