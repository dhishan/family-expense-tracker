"""Notification model."""
from datetime import datetime
from typing import Optional, List
from pydantic import BaseModel
from enum import Enum


class NotificationType(str, Enum):
    """Notification types."""
    BUDGET_WARNING = "budget_warning"  # Approaching budget limit (e.g., 80%)
    BUDGET_EXCEEDED = "budget_exceeded"  # Over budget
    FAMILY_JOINED = "family_joined"  # New member joined family
    EXPENSE_ADDED = "expense_added"  # Large expense added


class NotificationBase(BaseModel):
    """Base notification model."""
    type: NotificationType
    title: str
    message: str
    related_budget_id: Optional[str] = None
    related_expense_id: Optional[str] = None


class Notification(NotificationBase):
    """Notification model with all fields."""
    id: str
    family_id: str
    user_id: str  # Recipient
    read: bool = False
    created_at: datetime

    class Config:
        from_attributes = True


class NotificationResponse(BaseModel):
    """Notification response model."""
    id: str
    family_id: str
    user_id: str
    type: str
    title: str
    message: str
    read: bool
    created_at: datetime
    related_budget_id: Optional[str] = None
    related_expense_id: Optional[str] = None


class NotificationListResponse(BaseModel):
    """List of notifications."""
    notifications: List[NotificationResponse]
    unread_count: int
    total: int
