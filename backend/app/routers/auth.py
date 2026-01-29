"""Authentication router."""
from datetime import datetime
from fastapi import APIRouter, HTTPException, status, Depends
from pydantic import BaseModel

from app.auth.google import verify_google_token, get_google_user_info
from app.auth.dependencies import create_access_token, get_current_user
from app.models.user import User, UserResponse
from app.services.firestore import get_firestore_client

router = APIRouter()


class GoogleAuthRequest(BaseModel):
    """Google authentication request."""
    token: str  # Google ID token or access token
    token_type: str = "id_token"  # "id_token" or "access_token"


class AuthResponse(BaseModel):
    """Authentication response."""
    access_token: str
    token_type: str = "bearer"
    user: UserResponse


@router.post("/google", response_model=AuthResponse)
async def google_auth(request: GoogleAuthRequest):
    """
    Authenticate with Google OAuth.
    
    Accepts either a Google ID token or access token.
    Creates user if not exists, returns JWT token.
    """
    try:
        # Verify Google token and get user info
        if request.token_type == "id_token":
            google_user = await verify_google_token(request.token)
        else:
            google_user = await get_google_user_info(request.token)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=str(e),
        )
    
    db = get_firestore_client()
    user_ref = db.collection("users").document(google_user["id"])
    user_doc = user_ref.get()
    
    now = datetime.utcnow()
    
    if user_doc.exists:
        # Update existing user
        user_data = user_doc.to_dict()
        user_ref.update({
            "display_name": google_user["name"],
            "photo_url": google_user.get("picture"),
            "updated_at": now,
        })
        user_data.update({
            "id": google_user["id"],
            "display_name": google_user["name"],
            "photo_url": google_user.get("picture"),
            "updated_at": now,
        })
    else:
        # Create new user
        user_data = {
            "id": google_user["id"],
            "email": google_user["email"],
            "display_name": google_user["name"],
            "photo_url": google_user.get("picture"),
            "family_id": None,
            "created_at": now,
            "updated_at": now,
        }
        user_ref.set({k: v for k, v in user_data.items() if k != "id"})
    
    # Create JWT token
    access_token = create_access_token(
        user_id=google_user["id"],
        email=google_user["email"],
    )
    
    return AuthResponse(
        access_token=access_token,
        user=UserResponse(**user_data),
    )


@router.get("/me", response_model=UserResponse)
async def get_current_user_info(current_user: User = Depends(get_current_user)):
    """Get current authenticated user info."""
    return UserResponse(
        id=current_user.id,
        email=current_user.email,
        display_name=current_user.display_name,
        photo_url=current_user.photo_url,
        family_id=current_user.family_id,
        created_at=current_user.created_at,
        updated_at=current_user.updated_at,
    )


@router.post("/logout")
async def logout(current_user: User = Depends(get_current_user)):
    """
    Logout current user.
    
    Note: Since we use JWTs, actual token invalidation happens client-side.
    This endpoint can be used to log the event or invalidate refresh tokens.
    """
    return {"message": "Logged out successfully"}
