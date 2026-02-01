"""Pytest configuration and fixtures."""
import pytest
import os
from datetime import datetime
from unittest.mock import MagicMock, patch
from fastapi.testclient import TestClient

# Set test environment before importing app
os.environ['ENVIRONMENT'] = 'test'
os.environ['GCP_PROJECT_ID'] = 'test-project'
os.environ['FIRESTORE_DATABASE'] = 'test-database'
os.environ['GOOGLE_CLIENT_ID'] = 'test-client-id'
os.environ['JWT_SECRET_KEY'] = 'test-secret-key-for-testing-only'
os.environ['FRONTEND_URL'] = 'http://localhost:5173'

from app.main import app
from app.models.user import User


@pytest.fixture
def client():
    """Create a test client."""
    return TestClient(app)


@pytest.fixture
def mock_user():
    """Create a mock user for testing."""
    return User(
        id="test-user-123",
        email="test@example.com",
        display_name="Test User",
        photo_url="https://example.com/photo.jpg",
        family_id="test-family-123",
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )


@pytest.fixture
def mock_user_no_family():
    """Create a mock user without a family."""
    return User(
        id="test-user-456",
        email="nofamily@example.com",
        display_name="No Family User",
        photo_url=None,
        family_id=None,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )


@pytest.fixture
def auth_headers():
    """Create mock auth headers."""
    return {"Authorization": "Bearer mock-token"}


@pytest.fixture
def mock_firestore():
    """Create a mock Firestore client."""
    with patch('app.services.firestore.get_firestore_client') as mock:
        mock_db = MagicMock()
        mock.return_value = mock_db
        yield mock_db


@pytest.fixture
def mock_auth(mock_user):
    """Mock the authentication dependency."""
    with patch('app.auth.dependencies.get_current_user') as mock:
        mock.return_value = mock_user
        yield mock
