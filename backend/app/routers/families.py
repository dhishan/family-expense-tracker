"""Families router."""
import secrets
from datetime import datetime
from fastapi import APIRouter, HTTPException, status, Depends
from google.cloud.firestore_v1.base_query import FieldFilter

from app.auth.dependencies import get_current_user
from app.models.user import User
from app.models.family import (
    FamilyCreate,
    FamilyResponse,
    FamilyWithMembers,
    FamilyMember,
    JoinFamilyRequest,
    FamilySettingsUpdate,
)
from app.services.firestore import get_firestore_client

router = APIRouter()


def generate_invite_code() -> str:
    """Generate a unique invite code."""
    return secrets.token_urlsafe(8)


@router.post("", response_model=FamilyResponse, status_code=status.HTTP_201_CREATED)
async def create_family(
    family: FamilyCreate,
    current_user: User = Depends(get_current_user),
):
    """Create a new family and add the current user as the first member."""
    if current_user.family_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You are already a member of a family. Leave your current family first.",
        )
    
    db = get_firestore_client()
    now = datetime.utcnow()
    
    # Initialize beneficiary labels with creator
    beneficiary_labels = family.beneficiary_labels.copy()
    beneficiary_labels[current_user.id] = current_user.display_name
    
    # Create family
    family_data = {
        "name": family.name,
        "created_at": now,
        "created_by": current_user.id,
        "invite_code": generate_invite_code(),
        "categories": family.categories,
        "beneficiary_labels": beneficiary_labels,
    }
    
    family_ref = db.collection("families").document()
    family_ref.set(family_data)
    
    # Update user with family_id
    user_ref = db.collection("users").document(current_user.id)
    user_ref.update({
        "family_id": family_ref.id,
        "updated_at": now,
    })
    
    family_data["id"] = family_ref.id
    
    return FamilyResponse(**family_data)


@router.get("/{family_id}", response_model=FamilyWithMembers)
async def get_family(
    family_id: str,
    current_user: User = Depends(get_current_user),
):
    """Get family details with members list."""
    if current_user.family_id != family_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You don't have access to this family",
        )
    
    db = get_firestore_client()
    
    # Get family
    family_doc = db.collection("families").document(family_id).get()
    
    if not family_doc.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Family not found",
        )
    
    family_data = family_doc.to_dict()
    family_data["id"] = family_doc.id
    
    # Get members
    members_query = db.collection("users").where(
        filter=FieldFilter("family_id", "==", family_id)
    )
    
    members = []
    beneficiary_labels = family_data.get("beneficiary_labels", {"family": "Entire Family"})
    needs_update = False
    
    for member_doc in members_query.stream():
        member_data = member_doc.to_dict()
        members.append(FamilyMember(
            id=member_doc.id,
            email=member_data["email"],
            display_name=member_data["display_name"],
            photo_url=member_data.get("photo_url"),
        ))
        
        # Automatically add member to beneficiary_labels if not present
        if member_doc.id not in beneficiary_labels:
            beneficiary_labels[member_doc.id] = member_data["display_name"]
            needs_update = True
    
    # Update family if new members were added to labels
    if needs_update:
        family_ref = db.collection("families").document(family_id)
        family_ref.update({"beneficiary_labels": beneficiary_labels})
        family_data["beneficiary_labels"] = beneficiary_labels
    
    return FamilyWithMembers(
        **family_data,
        members=members,
    )


@router.post("/{family_id}/join", response_model=FamilyResponse)
async def join_family(
    family_id: str,
    request: JoinFamilyRequest,
    current_user: User = Depends(get_current_user),
):
    """Join a family using an invite code."""
    if current_user.family_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You are already a member of a family. Leave your current family first.",
        )
    
    db = get_firestore_client()
    
    # Get family
    family_doc = db.collection("families").document(family_id).get()
    
    if not family_doc.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Family not found",
        )
    
    family_data = family_doc.to_dict()
    
    # Verify invite code
    if family_data.get("invite_code") != request.invite_code:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid invite code",
        )
    
    # Update user with family_id
    now = datetime.utcnow()
    user_ref = db.collection("users").document(current_user.id)
    user_ref.update({
        "family_id": family_id,
        "updated_at": now,
    })
    
    family_data["id"] = family_doc.id
    
    return FamilyResponse(**family_data)


@router.post("/join-by-code", response_model=FamilyResponse)
async def join_family_by_code(
    request: JoinFamilyRequest,
    current_user: User = Depends(get_current_user),
):
    """Join a family using only the invite code (without knowing the family ID)."""
    if current_user.family_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You are already a member of a family. Leave your current family first.",
        )
    
    db = get_firestore_client()
    
    # Find family by invite code
    families_query = db.collection("families").where(
        filter=FieldFilter("invite_code", "==", request.invite_code)
    ).limit(1)
    
    family_docs = list(families_query.stream())
    
    if not family_docs:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Invalid invite code",
        )
    
    family_doc = family_docs[0]
    family_data = family_doc.to_dict()
    
    # Update user with family_id
    now = datetime.utcnow()
    user_ref = db.collection("users").document(current_user.id)
    user_ref.update({
        "family_id": family_doc.id,
        "updated_at": now,
    })
    
    family_data["id"] = family_doc.id
    
    return FamilyResponse(**family_data)


@router.get("/{family_id}/members", response_model=list[FamilyMember])
async def get_family_members(
    family_id: str,
    current_user: User = Depends(get_current_user),
):
    """Get list of family members."""
    if current_user.family_id != family_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You don't have access to this family",
        )
    
    db = get_firestore_client()
    
    members_query = db.collection("users").where(
        filter=FieldFilter("family_id", "==", family_id)
    )
    
    members = []
    for member_doc in members_query.stream():
        member_data = member_doc.to_dict()
        members.append(FamilyMember(
            id=member_doc.id,
            email=member_data["email"],
            display_name=member_data["display_name"],
            photo_url=member_data.get("photo_url"),
        ))
    
    return members


@router.post("/{family_id}/leave")
async def leave_family(
    family_id: str,
    current_user: User = Depends(get_current_user),
):
    """Leave the current family."""
    if current_user.family_id != family_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You are not a member of this family",
        )
    
    db = get_firestore_client()
    
    # Update user to remove family_id
    now = datetime.utcnow()
    user_ref = db.collection("users").document(current_user.id)
    user_ref.update({
        "family_id": None,
        "updated_at": now,
    })
    
    return {"message": "Successfully left the family"}


@router.post("/{family_id}/regenerate-invite")
async def regenerate_invite_code(
    family_id: str,
    current_user: User = Depends(get_current_user),
):
    """Regenerate the family invite code."""
    if current_user.family_id != family_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You don't have access to this family",
        )
    
    db = get_firestore_client()
    
    new_code = generate_invite_code()
    
    family_ref = db.collection("families").document(family_id)
    family_ref.update({"invite_code": new_code})
    
    return {"invite_code": new_code}


@router.put("/{family_id}/settings", response_model=FamilyResponse)
async def update_family_settings(
    family_id: str,
    settings: FamilySettingsUpdate,
    current_user: User = Depends(get_current_user),
):
    """Update family settings (categories and beneficiary labels)."""
    if current_user.family_id != family_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You don't have access to this family",
        )
    
    db = get_firestore_client()
    
    # Prepare update data
    update_data = {}
    if settings.categories is not None:
        if not settings.categories:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Categories list cannot be empty",
            )
        update_data["categories"] = settings.categories
    
    if settings.beneficiary_labels is not None:
        if "family" not in settings.beneficiary_labels:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Beneficiary labels must include 'family' key",
            )
        update_data["beneficiary_labels"] = settings.beneficiary_labels
    
    if not update_data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No settings to update",
        )
    
    # Update family
    family_ref = db.collection("families").document(family_id)
    family_ref.update(update_data)
    
    # Get updated family
    family_doc = family_ref.get()
    family_data = family_doc.to_dict()
    family_data["id"] = family_doc.id
    
    return FamilyResponse(**family_data)
