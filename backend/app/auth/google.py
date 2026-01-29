"""Google OAuth authentication."""
from google.oauth2 import id_token
from google.auth.transport import requests
import httpx

from app.config import get_settings

settings = get_settings()


async def verify_google_token(token: str) -> dict:
    """
    Verify a Google OAuth token and return user info.
    
    Args:
        token: Google ID token
        
    Returns:
        User info dict with id, email, name, picture
        
    Raises:
        ValueError: If token is invalid
    """
    try:
        # Verify the token
        idinfo = id_token.verify_oauth2_token(
            token, 
            requests.Request(), 
            settings.google_client_id
        )

        # Verify issuer
        if idinfo['iss'] not in ['accounts.google.com', 'https://accounts.google.com']:
            raise ValueError('Invalid issuer')

        return {
            'id': idinfo['sub'],
            'email': idinfo['email'],
            'name': idinfo.get('name', idinfo['email'].split('@')[0]),
            'picture': idinfo.get('picture'),
        }
    except Exception as e:
        raise ValueError(f'Invalid token: {str(e)}')


async def get_google_user_info(access_token: str) -> dict:
    """
    Get user info from Google using an access token.
    
    Args:
        access_token: Google OAuth access token
        
    Returns:
        User info dict
    """
    async with httpx.AsyncClient() as client:
        response = await client.get(
            'https://www.googleapis.com/oauth2/v2/userinfo',
            headers={'Authorization': f'Bearer {access_token}'}
        )
        
        if response.status_code != 200:
            raise ValueError('Failed to get user info from Google')
        
        data = response.json()
        return {
            'id': data['id'],
            'email': data['email'],
            'name': data.get('name', data['email'].split('@')[0]),
            'picture': data.get('picture'),
        }
