"""Family model."""
from datetime import datetime
from typing import Optional, List
from pydantic import BaseModel


class FamilyBase(BaseModel):
    """Base family model."""
    name: str
    categories: List[str] = [
        "groceries", "dining", "transportation", "utilities", 
        "entertainment", "healthcare", "shopping", "travel", 
        "education", "other"
    ]
    beneficiary_labels: dict[str, str] = {"family": "Entire Family"}


class FamilyCreate(FamilyBase):
    """Family creation model."""
    pass


class Family(FamilyBase):
    """Family model with all fields."""
    id: str
    created_at: datetime
    created_by: str
    invite_code: str

    class Config:
        from_attributes = True


class FamilyResponse(BaseModel):
    """Family response model."""
    id: str
    name: str
    created_at: datetime
    created_by: str
    invite_code: str
    categories: List[str]
    beneficiary_labels: dict[str, str]


class FamilyWithMembers(FamilyResponse):
    """Family response with members list."""
    members: List["FamilyMember"] = []


class FamilyMember(BaseModel):
    """Family member info."""
    id: str
    email: str
    display_name: str
    photo_url: Optional[str] = None


class JoinFamilyRequest(BaseModel):
    """Request to join a family."""
    invite_code: str


class FamilySettingsUpdate(BaseModel):
    """Update family settings."""
    categories: Optional[List[str]] = None
    beneficiary_labels: Optional[dict[str, str]] = None


# Update forward reference
FamilyWithMembers.model_rebuild()
