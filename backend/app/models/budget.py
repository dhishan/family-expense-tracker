"""Budget model."""
from datetime import datetime, date
from typing import Optional, List
from pydantic import BaseModel, Field
from enum import Enum


class BudgetPeriod(str, Enum):
    """Budget period types."""
    WEEKLY = "weekly"
    MONTHLY = "monthly"
    YEARLY = "yearly"


class BudgetBase(BaseModel):
    """Base budget model."""
    name: str = Field(..., min_length=1, max_length=100)
    amount: float = Field(..., gt=0, description="Budget limit amount")
    period: BudgetPeriod = BudgetPeriod.MONTHLY
    category: Optional[str] = Field(None, description="Category to track, null for all")
    beneficiary: Optional[str] = Field(None, description="User ID, 'family', or null for all")
    rollover_enabled: bool = Field(True, description="Carry unused budget forward to the next period (uncapped, cumulative)")
    ytd_view: bool = Field(
        False,
        description=(
            "When true, the budget reports spent + quota year-to-date "
            "(Jan 1 of the current year → today). Quota auto-scales by "
            "the number of periods elapsed this year. Useful for "
            "tracking annualized envelopes."
        ),
    )


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
    rollover_enabled: Optional[bool] = None
    ytd_view: Optional[bool] = None


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
    rollover_enabled: bool = True
    ytd_view: bool = False
    start_date: date
    created_by: str
    created_at: datetime
    updated_at: datetime


class BudgetStatus(BaseModel):
    """Budget status with spending info."""
    budget: BudgetResponse
    spent: float                                    # spent in the current period
    remaining: float                                # effective_amount - spent (can be negative if over)
    percentage_used: float                          # spent / effective_amount
    is_over_budget: bool                            # spent > effective_amount
    period_start: date
    period_end: date
    rollover_amount: float = 0.0                    # carry-over from prior periods (0 when disabled)
    effective_amount: float = 0.0                   # budget.amount + rollover_amount


class BudgetListResponse(BaseModel):
    """List of budgets with status."""
    budgets: List[BudgetStatus]
    total: int
