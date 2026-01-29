"""Budgets router."""
from fastapi import APIRouter, HTTPException, status, Depends

from app.auth.dependencies import get_current_user
from app.models.user import User
from app.models.budget import (
    BudgetCreate,
    BudgetUpdate,
    BudgetResponse,
    BudgetStatus,
    BudgetListResponse,
)
from app.services.budget_service import get_budget_service

router = APIRouter()


@router.post("", response_model=BudgetResponse, status_code=status.HTTP_201_CREATED)
async def create_budget(
    budget: BudgetCreate,
    current_user: User = Depends(get_current_user),
):
    """Create a new budget."""
    if not current_user.family_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You must be part of a family to create budgets",
        )
    
    budget_service = get_budget_service()
    
    try:
        return await budget_service.create(budget, current_user)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )


@router.get("", response_model=BudgetListResponse)
async def list_budgets(
    current_user: User = Depends(get_current_user),
):
    """List all budgets with their current status."""
    if not current_user.family_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You must be part of a family to view budgets",
        )
    
    budget_service = get_budget_service()
    statuses = await budget_service.list_with_status(current_user.family_id)
    
    return BudgetListResponse(
        budgets=statuses,
        total=len(statuses),
    )


@router.get("/{budget_id}", response_model=BudgetResponse)
async def get_budget(
    budget_id: str,
    current_user: User = Depends(get_current_user),
):
    """Get a specific budget."""
    if not current_user.family_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You must be part of a family to view budgets",
        )
    
    budget_service = get_budget_service()
    budget = await budget_service.get(budget_id, current_user.family_id)
    
    if not budget:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Budget not found",
        )
    
    return budget


@router.get("/{budget_id}/status", response_model=BudgetStatus)
async def get_budget_status(
    budget_id: str,
    current_user: User = Depends(get_current_user),
):
    """Get a budget's status with spending info."""
    if not current_user.family_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You must be part of a family to view budgets",
        )
    
    budget_service = get_budget_service()
    status = await budget_service.get_status(budget_id, current_user.family_id)
    
    if not status:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Budget not found",
        )
    
    return status


@router.put("/{budget_id}", response_model=BudgetResponse)
async def update_budget(
    budget_id: str,
    budget: BudgetUpdate,
    current_user: User = Depends(get_current_user),
):
    """Update a budget."""
    if not current_user.family_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You must be part of a family to update budgets",
        )
    
    budget_service = get_budget_service()
    result = await budget_service.update(
        budget_id,
        budget,
        current_user.family_id
    )
    
    if not result:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Budget not found",
        )
    
    return result


@router.delete("/{budget_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_budget(
    budget_id: str,
    current_user: User = Depends(get_current_user),
):
    """Delete a budget."""
    if not current_user.family_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You must be part of a family to delete budgets",
        )
    
    budget_service = get_budget_service()
    deleted = await budget_service.delete(budget_id, current_user.family_id)
    
    if not deleted:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Budget not found",
        )
