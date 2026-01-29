"""Budget service for CRUD operations."""
from datetime import datetime, date, timedelta
from typing import List, Optional, Tuple
from google.cloud.firestore_v1.base_query import FieldFilter

from app.models.budget import (
    BudgetCreate,
    BudgetUpdate,
    BudgetResponse,
    BudgetStatus,
    BudgetPeriod,
)
from app.models.user import User
from app.services.firestore import get_firestore_client
from app.services.expense_service import get_expense_service


class BudgetService:
    """Service for managing budgets."""
    
    def __init__(self):
        self.db = get_firestore_client()
        self.collection = self.db.collection("budgets")
    
    def _get_period_dates(
        self, 
        period: BudgetPeriod, 
        reference_date: Optional[date] = None
    ) -> Tuple[date, date]:
        """Get start and end dates for a budget period."""
        ref = reference_date or date.today()
        
        if period == BudgetPeriod.WEEKLY:
            # Week starts on Monday
            start = ref - timedelta(days=ref.weekday())
            end = start + timedelta(days=6)
        else:  # Monthly
            start = ref.replace(day=1)
            # Get last day of month
            if ref.month == 12:
                end = ref.replace(year=ref.year + 1, month=1, day=1) - timedelta(days=1)
            else:
                end = ref.replace(month=ref.month + 1, day=1) - timedelta(days=1)
        
        return start, end
    
    async def create(self, budget: BudgetCreate, user: User) -> BudgetResponse:
        """Create a new budget."""
        if not user.family_id:
            raise ValueError("User must belong to a family to create budgets")
        
        now = datetime.utcnow()
        
        # Set start date to current period if not provided
        start_date = budget.start_date
        if not start_date:
            start_date, _ = self._get_period_dates(budget.period)
        
        budget_data = {
            **budget.model_dump(exclude={"start_date"}),
            "start_date": datetime.combine(start_date, datetime.min.time()),
            "family_id": user.family_id,
            "created_by": user.id,
            "created_at": now,
            "updated_at": now,
        }
        
        # Create document
        doc_ref = self.collection.document()
        doc_ref.set(budget_data)
        
        budget_data["id"] = doc_ref.id
        budget_data["start_date"] = start_date
        
        return BudgetResponse(**budget_data)
    
    async def get(self, budget_id: str, family_id: str) -> Optional[BudgetResponse]:
        """Get a budget by ID."""
        doc = self.collection.document(budget_id).get()
        
        if not doc.exists:
            return None
        
        data = doc.to_dict()
        
        # Verify family ownership
        if data.get("family_id") != family_id:
            return None
        
        data["id"] = doc.id
        
        # Convert timestamp to date
        if isinstance(data.get("start_date"), datetime):
            data["start_date"] = data["start_date"].date()
        
        return BudgetResponse(**data)
    
    async def update(
        self,
        budget_id: str,
        budget: BudgetUpdate,
        family_id: str
    ) -> Optional[BudgetResponse]:
        """Update a budget."""
        doc_ref = self.collection.document(budget_id)
        doc = doc_ref.get()
        
        if not doc.exists:
            return None
        
        data = doc.to_dict()
        
        # Verify family ownership
        if data.get("family_id") != family_id:
            return None
        
        # Build update data
        update_data = {
            k: v for k, v in budget.model_dump().items()
            if v is not None
        }
        update_data["updated_at"] = datetime.utcnow()
        
        doc_ref.update(update_data)
        
        return await self.get(budget_id, family_id)
    
    async def delete(self, budget_id: str, family_id: str) -> bool:
        """Delete a budget."""
        doc_ref = self.collection.document(budget_id)
        doc = doc_ref.get()
        
        if not doc.exists:
            return False
        
        data = doc.to_dict()
        
        # Verify family ownership
        if data.get("family_id") != family_id:
            return False
        
        doc_ref.delete()
        return True
    
    async def list(self, family_id: str) -> List[BudgetResponse]:
        """List all budgets for a family."""
        query = self.collection.where(
            filter=FieldFilter("family_id", "==", family_id)
        )
        
        docs = query.stream()
        
        budgets = []
        for doc in docs:
            data = doc.to_dict()
            data["id"] = doc.id
            
            if isinstance(data.get("start_date"), datetime):
                data["start_date"] = data["start_date"].date()
            
            budgets.append(BudgetResponse(**data))
        
        return budgets
    
    async def get_status(
        self, 
        budget_id: str, 
        family_id: str
    ) -> Optional[BudgetStatus]:
        """Get budget status with spending info."""
        budget = await self.get(budget_id, family_id)
        
        if not budget:
            return None
        
        # Get current period dates
        period = BudgetPeriod(budget.period)
        period_start, period_end = self._get_period_dates(period)
        
        # Get spending
        expense_service = get_expense_service()
        spent = await expense_service.get_spending_for_budget(
            family_id=family_id,
            start_date=period_start,
            end_date=period_end,
            category=budget.category,
            beneficiary=budget.beneficiary,
        )
        
        remaining = budget.amount - spent
        percentage_used = (spent / budget.amount * 100) if budget.amount > 0 else 0
        
        return BudgetStatus(
            budget=budget,
            spent=spent,
            remaining=remaining,
            percentage_used=round(percentage_used, 2),
            is_over_budget=spent > budget.amount,
            period_start=period_start,
            period_end=period_end,
        )
    
    async def list_with_status(self, family_id: str) -> List[BudgetStatus]:
        """List all budgets with their current status."""
        budgets = await self.list(family_id)
        
        statuses = []
        for budget in budgets:
            status = await self.get_status(budget.id, family_id)
            if status:
                statuses.append(status)
        
        return statuses
    
    async def check_budget_alerts(
        self, 
        family_id: str
    ) -> List[Tuple[BudgetStatus, str]]:
        """
        Check all budgets and return alerts for any approaching/exceeding limits.
        
        Returns:
            List of (BudgetStatus, alert_type) tuples
        """
        statuses = await self.list_with_status(family_id)
        
        alerts = []
        for status in statuses:
            if status.is_over_budget:
                alerts.append((status, "exceeded"))
            elif status.percentage_used >= 80:
                alerts.append((status, "warning"))
        
        return alerts


# Singleton instance
budget_service = BudgetService()


def get_budget_service() -> BudgetService:
    """Get the budget service instance."""
    return budget_service
