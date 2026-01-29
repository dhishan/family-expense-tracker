"""User model."""
from datetime import datetime
from typing import Optional
from pydantic import BaseModel, EmailStr


class UserBase(BaseModel):
    """Base user model."""
    email: EmailStr
    display_name: str
    photo_url: Optional[str] = None


class UserCreate(UserBase):
    """User creation model."""
    id: str  # Google UID


class User(UserBase):
    """User model with all fields."""
    id: str
    family_id: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class UserResponse(BaseModel):
    """User response model."""
    id: str
    email: str
    display_name: str
    photo_url: Optional[str] = None
    family_id: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class UserUpdate(BaseModel):
    """User update model."""
    display_name: Optional[str] = None
    photo_url: Optional[str] = None
    family_id: Optional[str] = None
