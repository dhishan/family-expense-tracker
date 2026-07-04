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

        # Reject unverified emails. Google's library does not enforce this;
        # some Workspace configs can mint tokens with email_verified=false for
        # an unverified custom domain. The MCP auth path already checks this —
        # keep the two login paths consistent.
        if not idinfo.get('email_verified'):
            raise ValueError('Email not verified')

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
    Exchange a Google access token for user info AFTER verifying the token
    was issued for THIS app's OAuth client.

    Without the audience check, any valid Google access token (issued for
    any other Google OAuth client) can be exchanged for an app JWT — a
    confused-deputy. See docs/security-review-2026-06-15.md.

    Args:
        access_token: Google OAuth access token

    Returns:
        User info dict
    """
    async with httpx.AsyncClient() as client:
        # 1. Validate the token's audience via tokeninfo.
        tokeninfo = await client.get(
            'https://oauth2.googleapis.com/tokeninfo',
            params={'access_token': access_token},
        )
        if tokeninfo.status_code != 200:
            raise ValueError('Failed to validate Google access token')
        info = tokeninfo.json()
        # `aud` (preferred) or `audience` depending on Google API version
        aud = info.get('aud') or info.get('audience')
        expected = settings.google_client_id
        if not expected:
            raise ValueError('Server is missing google_client_id configuration')
        if aud != expected:
            raise ValueError(
                f'Access token audience mismatch (got {aud}, expected this app).'
            )
        if info.get('expires_in', 0) and int(info['expires_in']) <= 0:
            raise ValueError('Access token expired')

        # 2. Now safe to fetch userinfo.
        response = await client.get(
            'https://www.googleapis.com/oauth2/v2/userinfo',
            headers={'Authorization': f'Bearer {access_token}'},
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
