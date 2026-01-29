"""Expense model."""
from datetime import datetime, date
from typing import Optional, List, Literal
from pydantic import BaseModel, Field
from enum import Enum


class ExpenseCategory(str, Enum):
    """Expense categories."""
    GROCERIES = "groceries"
    DINING = "dining"
    TRANSPORTATION = "transportation"
    UTILITIES = "utilities"
    ENTERTAINMENT = "entertainment"
    HEALTHCARE = "healthcare"
    SHOPPING = "shopping"
    TRAVEL = "travel"
    EDUCATION = "education"
    OTHER = "other"


class PaymentMethod(str, Enum):
    """Payment methods."""
    CASH = "cash"
    CREDIT = "credit"
    DEBIT = "debit"
    BANK_TRANSFER = "bank_transfer"
    PAYPAL = "paypal"
    VENMO = "venmo"
    OTHER = "other"


class ExpenseBase(BaseModel):
    """Base expense model."""
    amount: float = Field(..., gt=0, description="Expense amount (must be positive)")
    currency: str = Field(default="USD", max_length=3)
    date: date
    description: str = Field(..., min_length=1, max_length=500)
    merchant: Optional[str] = Field(None, max_length=200)
    payment_method: PaymentMethod = PaymentMethod.CREDIT
    category: ExpenseCategory = ExpenseCategory.OTHER
    beneficiary: str = Field(..., description="User ID or 'family'")
    tags: List[str] = Field(default_factory=list)


class ExpenseCreate(ExpenseBase):
    """Expense creation model."""
    pass


class ExpenseUpdate(BaseModel):
    """Expense update model."""
    amount: Optional[float] = Field(None, gt=0)
    currency: Optional[str] = Field(None, max_length=3)
    date: Optional[date] = None
    description: Optional[str] = Field(None, min_length=1, max_length=500)
    merchant: Optional[str] = Field(None, max_length=200)
    payment_method: Optional[PaymentMethod] = None
    category: Optional[ExpenseCategory] = None
    beneficiary: Optional[str] = None
    tags: Optional[List[str]] = None


class Expense(ExpenseBase):
    """Expense model with all fields."""
    id: str
    family_id: str
    created_by: str
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class ExpenseResponse(BaseModel):
    """Expense response model."""
    id: str
    family_id: str
    amount: float
    currency: str
    date: date
    description: str
    merchant: Optional[str]
    payment_method: str
    category: str
    beneficiary: str
    tags: List[str]
    created_by: str
    created_at: datetime
    updated_at: datetime


class ExpenseListResponse(BaseModel):
    """Paginated expense list response."""
    expenses: List[ExpenseResponse]
    total: int
    page: int
    page_size: int
    has_more: bool


class ExpenseSummary(BaseModel):
    """Expense summary/analytics model."""
    total_amount: float
    by_category: dict[str, float]
    by_beneficiary: dict[str, float]
    by_payment_method: dict[str, float]
    expense_count: int
    period_start: date
    period_end: date


class ExpenseFilters(BaseModel):
    """Filters for expense queries."""
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    category: Optional[ExpenseCategory] = None
    beneficiary: Optional[str] = None
    payment_method: Optional[PaymentMethod] = None
    min_amount: Optional[float] = None
    max_amount: Optional[float] = None
    search: Optional[str] = None
