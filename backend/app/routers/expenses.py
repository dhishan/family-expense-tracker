"""Expenses router."""
from datetime import date, timedelta
from typing import Optional
from fastapi import APIRouter, HTTPException, status, Depends, Query

from app.auth.dependencies import get_current_user
from app.models.user import User
from app.models.expense import (
    ExpenseCreate,
    ExpenseUpdate,
    ExpenseResponse,
    ExpenseListResponse,
    ExpenseSummary,
    ExpenseFilters,
    ExpenseCategory,
    PaymentMethod,
)
from app.services.expense_service import get_expense_service
from app.services.budget_service import get_budget_service
from app.services.notification_service import get_notification_service
from app.services.firestore import get_firestore_client
from google.cloud.firestore_v1.base_query import FieldFilter

router = APIRouter()


async def check_budgets_after_expense(family_id: str):
    """Check budgets after adding an expense and create notifications."""
    budget_service = get_budget_service()
    notification_service = get_notification_service()
    
    # Get budget alerts
    alerts = await budget_service.check_budget_alerts(family_id)
    
    if alerts:
        # Get family members to notify
        db = get_firestore_client()
        members_query = db.collection("users").where(
            filter=FieldFilter("family_id", "==", family_id)
        )
        member_ids = [doc.id for doc in members_query.stream()]
        
        for status, alert_type in alerts:
            await notification_service.create_budget_alert(
                budget_status=status,
                user_ids=member_ids,
                alert_type=alert_type,
            )


@router.post("", response_model=ExpenseResponse, status_code=status.HTTP_201_CREATED)
async def create_expense(
    expense: ExpenseCreate,
    current_user: User = Depends(get_current_user),
):
    """Create a new expense."""
    if not current_user.family_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You must be part of a family to create expenses",
        )
    
    expense_service = get_expense_service()
    
    try:
        result = await expense_service.create(expense, current_user)
        
        # Check budgets asynchronously (don't block response)
        await check_budgets_after_expense(current_user.family_id)
        
        return result
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )


@router.get("", response_model=ExpenseListResponse)
async def list_expenses(
    current_user: User = Depends(get_current_user),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    start_date: Optional[date] = None,
    end_date: Optional[date] = None,
    category: Optional[ExpenseCategory] = None,
    beneficiary: Optional[str] = None,
    payment_method: Optional[PaymentMethod] = None,
    min_amount: Optional[float] = None,
    max_amount: Optional[float] = None,
    search: Optional[str] = None,
):
    """List expenses with optional filters and pagination."""
    if not current_user.family_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You must be part of a family to view expenses",
        )
    
    filters = ExpenseFilters(
        start_date=start_date,
        end_date=end_date,
        category=category,
        beneficiary=beneficiary,
        payment_method=payment_method,
        min_amount=min_amount,
        max_amount=max_amount,
        search=search,
    )
    
    expense_service = get_expense_service()
    expenses, total, has_more = await expense_service.list(
        family_id=current_user.family_id,
        filters=filters,
        page=page,
        page_size=page_size,
    )
    
    return ExpenseListResponse(
        expenses=expenses,
        total=total,
        page=page,
        page_size=page_size,
        has_more=has_more,
    )


@router.get("/summary", response_model=ExpenseSummary)
async def get_expense_summary(
    current_user: User = Depends(get_current_user),
    start_date: Optional[date] = None,
    end_date: Optional[date] = None,
    beneficiary: Optional[str] = None,
):
    """Get expense summary/analytics for a period."""
    if not current_user.family_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You must be part of a family to view expenses",
        )
    
    # Default to current month
    if not start_date:
        today = date.today()
        start_date = today.replace(day=1)
    
    if not end_date:
        # Last day of month
        today = date.today()
        if today.month == 12:
            end_date = today.replace(year=today.year + 1, month=1, day=1) - timedelta(days=1)
        else:
            end_date = today.replace(month=today.month + 1, day=1) - timedelta(days=1)
    
    expense_service = get_expense_service()
    
    return await expense_service.get_summary(
        family_id=current_user.family_id,
        start_date=start_date,
        end_date=end_date,
        beneficiary=beneficiary,
    )


@router.get("/{expense_id}", response_model=ExpenseResponse)
async def get_expense(
    expense_id: str,
    current_user: User = Depends(get_current_user),
):
    """Get a specific expense."""
    if not current_user.family_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You must be part of a family to view expenses",
        )
    
    expense_service = get_expense_service()
    expense = await expense_service.get(expense_id, current_user.family_id)
    
    if not expense:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Expense not found",
        )
    
    return expense


@router.put("/{expense_id}", response_model=ExpenseResponse)
async def update_expense(
    expense_id: str,
    expense: ExpenseUpdate,
    current_user: User = Depends(get_current_user),
):
    """Update an expense."""
    if not current_user.family_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You must be part of a family to update expenses",
        )
    
    expense_service = get_expense_service()
    result = await expense_service.update(
        expense_id, 
        expense, 
        current_user.family_id
    )
    
    if not result:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Expense not found",
        )
    
    return result


@router.delete("/{expense_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_expense(
    expense_id: str,
    current_user: User = Depends(get_current_user),
):
    """Delete an expense."""
    if not current_user.family_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You must be part of a family to delete expenses",
        )
    
    expense_service = get_expense_service()
    deleted = await expense_service.delete(expense_id, current_user.family_id)
    
    if not deleted:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Expense not found",
        )
