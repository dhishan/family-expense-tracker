"""Budget model."""
from datetime import datetime, date
from typing import Optional, List
from pydantic import BaseModel, Field
from enum import Enum


class BudgetPeriod(str, Enum):
    """Budget period types."""
    WEEKLY = "weekly"
    MONTHLY = "monthly"


class BudgetBase(BaseModel):
    """Base budget model."""
    name: str = Field(..., min_length=1, max_length=100)
    amount: float = Field(..., gt=0, description="Budget limit amount")
    period: BudgetPeriod = BudgetPeriod.MONTHLY
    category: Optional[str] = Field(None, description="Category to track, null for all")
    beneficiary: Optional[str] = Field(None, description="User ID, 'family', or null for all")


class BudgetCreate(BudgetBase):
    """Budget creation model."""
    start_date: Optional[date] = None  # Defaults to current period start


class BudgetUpdate(BaseModel):
    """Budget update model."""
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    amount: Optional[float] = Field(None, gt=0)
    period: Optional[BudgetPeriod] = None
    category: Optional[str] = None
    beneficiary: Optional[str] = None


class Budget(BudgetBase):
    """Budget model with all fields."""
    id: str
    family_id: str
    start_date: date
    created_by: str
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class BudgetResponse(BaseModel):
    """Budget response model."""
    id: str
    family_id: str
    name: str
    amount: float
    period: str
    category: Optional[str]
    beneficiary: Optional[str]
    start_date: date
    created_by: str
    created_at: datetime
    updated_at: datetime


class BudgetStatus(BaseModel):
    """Budget status with spending info."""
    budget: BudgetResponse
    spent: float
    remaining: float
    percentage_used: float
    is_over_budget: bool
    period_start: date
    period_end: date


class BudgetListResponse(BaseModel):
    """List of budgets with status."""
    budgets: List[BudgetStatus]
    total: int
