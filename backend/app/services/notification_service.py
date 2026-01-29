"""Notification service for managing notifications."""
from datetime import datetime
from typing import List, Optional
from google.cloud.firestore_v1.base_query import FieldFilter

from app.models.notification import (
    NotificationType,
    NotificationResponse,
)
from app.models.budget import BudgetStatus
from app.services.firestore import get_firestore_client


class NotificationService:
    """Service for managing notifications."""
    
    def __init__(self):
        self.db = get_firestore_client()
        self.collection = self.db.collection("notifications")
    
    async def create(
        self,
        family_id: str,
        user_id: str,
        notification_type: NotificationType,
        title: str,
        message: str,
        related_budget_id: Optional[str] = None,
        related_expense_id: Optional[str] = None,
    ) -> NotificationResponse:
        """Create a new notification."""
        now = datetime.utcnow()
        
        notification_data = {
            "family_id": family_id,
            "user_id": user_id,
            "type": notification_type.value,
            "title": title,
            "message": message,
            "read": False,
            "created_at": now,
            "related_budget_id": related_budget_id,
            "related_expense_id": related_expense_id,
        }
        
        doc_ref = self.collection.document()
        doc_ref.set(notification_data)
        
        notification_data["id"] = doc_ref.id
        
        return NotificationResponse(**notification_data)
    
    async def list(
        self,
        user_id: str,
        unread_only: bool = False,
        limit: int = 50,
    ) -> List[NotificationResponse]:
        """List notifications for a user."""
        query = self.collection.where(
            filter=FieldFilter("user_id", "==", user_id)
        )
        
        if unread_only:
            query = query.where(filter=FieldFilter("read", "==", False))
        
        query = query.order_by("created_at", direction="DESCENDING").limit(limit)
        
        docs = query.stream()
        
        notifications = []
        for doc in docs:
            data = doc.to_dict()
            data["id"] = doc.id
            notifications.append(NotificationResponse(**data))
        
        return notifications
    
    async def get_unread_count(self, user_id: str) -> int:
        """Get count of unread notifications."""
        query = self.collection.where(
            filter=FieldFilter("user_id", "==", user_id)
        ).where(
            filter=FieldFilter("read", "==", False)
        )
        
        count_result = query.count().get()
        return count_result[0][0].value
    
    async def mark_as_read(self, notification_id: str, user_id: str) -> bool:
        """Mark a notification as read."""
        doc_ref = self.collection.document(notification_id)
        doc = doc_ref.get()
        
        if not doc.exists:
            return False
        
        data = doc.to_dict()
        
        # Verify ownership
        if data.get("user_id") != user_id:
            return False
        
        doc_ref.update({"read": True})
        return True
    
    async def mark_all_as_read(self, user_id: str) -> int:
        """Mark all notifications as read for a user."""
        query = self.collection.where(
            filter=FieldFilter("user_id", "==", user_id)
        ).where(
            filter=FieldFilter("read", "==", False)
        )
        
        docs = query.stream()
        
        count = 0
        batch = self.db.batch()
        
        for doc in docs:
            batch.update(doc.reference, {"read": True})
            count += 1
            
            # Firestore batch limit is 500
            if count % 500 == 0:
                batch.commit()
                batch = self.db.batch()
        
        if count % 500 != 0:
            batch.commit()
        
        return count
    
    async def create_budget_alert(
        self,
        budget_status: BudgetStatus,
        user_ids: List[str],
        alert_type: str,  # "warning" or "exceeded"
    ) -> List[NotificationResponse]:
        """Create budget alert notifications for multiple users."""
        if alert_type == "exceeded":
            notification_type = NotificationType.BUDGET_EXCEEDED
            title = f"Budget Exceeded: {budget_status.budget.name}"
            message = (
                f"You've spent ${budget_status.spent:.2f} of your "
                f"${budget_status.budget.amount:.2f} budget "
                f"({budget_status.percentage_used:.1f}%)"
            )
        else:  # warning
            notification_type = NotificationType.BUDGET_WARNING
            title = f"Budget Warning: {budget_status.budget.name}"
            message = (
                f"You've used {budget_status.percentage_used:.1f}% of your "
                f"${budget_status.budget.amount:.2f} budget"
            )
        
        notifications = []
        for user_id in user_ids:
            notification = await self.create(
                family_id=budget_status.budget.family_id,
                user_id=user_id,
                notification_type=notification_type,
                title=title,
                message=message,
                related_budget_id=budget_status.budget.id,
            )
            notifications.append(notification)
        
        return notifications


# Singleton instance
notification_service = NotificationService()


def get_notification_service() -> NotificationService:
    """Get the notification service instance."""
    return notification_service
