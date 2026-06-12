"""Merchant auto-rules router.

Endpoints:
  GET    /api/v1/rules/merchant            List all rules for the family
  POST   /api/v1/rules/merchant            Create a rule (409 on duplicate merchant)
  DELETE /api/v1/rules/merchant/{rule_id}  Delete a rule
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from typing import Optional

from app.auth.dependencies import get_current_user
from app.models.user import User
from app.services import rule_service

router = APIRouter()


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------


class MerchantRuleCreate(BaseModel):
    merchant_name: str = Field(..., min_length=1, max_length=200)
    category: str = Field(..., min_length=1)
    budget_id: Optional[str] = None
    beneficiary: Optional[str] = None


class MerchantRuleResponse(BaseModel):
    id: str
    family_id: str
    user_id: Optional[str] = None
    merchant_name: str
    category: str
    budget_id: Optional[str] = None
    beneficiary: Optional[str] = None
    applied_count: int = 0
    last_applied_at: Optional[object] = None
    created_at: Optional[object] = None


def _to_response(rule: dict) -> MerchantRuleResponse:
    return MerchantRuleResponse(
        id=rule["id"],
        family_id=rule["family_id"],
        user_id=rule.get("user_id"),
        merchant_name=rule["merchant_name"],
        category=rule["category"],
        budget_id=rule.get("budget_id"),
        beneficiary=rule.get("beneficiary"),
        applied_count=rule.get("applied_count") or 0,
        last_applied_at=rule.get("last_applied_at"),
        created_at=rule.get("created_at"),
    )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/merchant")
async def list_merchant_rules(
    current_user: User = Depends(get_current_user),
) -> dict:
    """List all merchant auto-rules for the current user's family."""
    if not current_user.family_id:
        raise HTTPException(status_code=400, detail="User must belong to a family")
    rules = rule_service.list_for_family(current_user.family_id)
    return {"rules": [_to_response(r).model_dump() for r in rules]}


@router.post("/merchant", status_code=201)
async def create_merchant_rule(
    body: MerchantRuleCreate,
    current_user: User = Depends(get_current_user),
) -> dict:
    """Create a merchant auto-rule. Returns 409 if a rule for this merchant already exists."""
    if not current_user.family_id:
        raise HTTPException(status_code=400, detail="User must belong to a family")
    try:
        rule = rule_service.create(
            family_id=current_user.family_id,
            user_id=current_user.id,
            merchant_name=body.merchant_name,
            category=body.category,
            budget_id=body.budget_id,
            beneficiary=body.beneficiary,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    return {"rule": _to_response(rule).model_dump()}


@router.delete("/merchant/{rule_id}", status_code=200)
async def delete_merchant_rule(
    rule_id: str,
    current_user: User = Depends(get_current_user),
) -> dict:
    """Delete a merchant auto-rule."""
    if not current_user.family_id:
        raise HTTPException(status_code=400, detail="User must belong to a family")
    deleted = rule_service.delete(rule_id, current_user.family_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Rule not found")
    return {"deleted": True}
