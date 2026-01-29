"""Notifications router."""
from fastapi import APIRouter, HTTPException, status, Depends, Query

from app.auth.dependencies import get_current_user
from app.models.user import User
from app.models.notification import NotificationListResponse
from app.services.notification_service import get_notification_service

router = APIRouter()


@router.get("", response_model=NotificationListResponse)
async def list_notifications(
    current_user: User = Depends(get_current_user),
    unread_only: bool = Query(False),
    limit: int = Query(50, ge=1, le=100),
):
    """List notifications for the current user."""
    notification_service = get_notification_service()
    
    notifications = await notification_service.list(
        user_id=current_user.id,
        unread_only=unread_only,
        limit=limit,
    )
    
    unread_count = await notification_service.get_unread_count(current_user.id)
    
    return NotificationListResponse(
        notifications=notifications,
        unread_count=unread_count,
        total=len(notifications),
    )


@router.put("/{notification_id}/read")
async def mark_notification_as_read(
    notification_id: str,
    current_user: User = Depends(get_current_user),
):
    """Mark a notification as read."""
    notification_service = get_notification_service()
    
    success = await notification_service.mark_as_read(
        notification_id=notification_id,
        user_id=current_user.id,
    )
    
    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Notification not found",
        )
    
    return {"message": "Notification marked as read"}


@router.put("/read-all")
async def mark_all_notifications_as_read(
    current_user: User = Depends(get_current_user),
):
    """Mark all notifications as read."""
    notification_service = get_notification_service()
    
    count = await notification_service.mark_all_as_read(user_id=current_user.id)
    
    return {"message": f"Marked {count} notifications as read"}


@router.get("/unread-count")
async def get_unread_count(
    current_user: User = Depends(get_current_user),
):
    """Get count of unread notifications."""
    notification_service = get_notification_service()
    
    count = await notification_service.get_unread_count(current_user.id)
    
    return {"unread_count": count}
