"""Expense service for CRUD operations."""
from datetime import datetime, date, timedelta
from typing import List, Optional, Tuple
from google.cloud.firestore_v1.base_query import FieldFilter

from app.models.expense import (
    ExpenseCreate, 
    ExpenseUpdate, 
    ExpenseResponse,
    ExpenseSummary,
    ExpenseFilters,
    ExpenseCategory,
)
from app.models.user import User
from app.services.firestore import get_firestore_client, get_server_timestamp


class ExpenseService:
    """Service for managing expenses."""
    
    def __init__(self):
        self.db = get_firestore_client()
        self.collection = self.db.collection("expenses")
    
    async def create(self, expense: ExpenseCreate, user: User) -> ExpenseResponse:
        """Create a new expense."""
        if not user.family_id:
            raise ValueError("User must belong to a family to create expenses")
        
        now = datetime.utcnow()
        expense_data = {
            **expense.model_dump(),
            "family_id": user.family_id,
            "created_by": user.id,
            "created_at": now,
            "updated_at": now,
            "date": datetime.combine(expense.date, datetime.min.time()),
        }
        
        # Create document
        doc_ref = self.collection.document()
        doc_ref.set(expense_data)
        
        expense_data["id"] = doc_ref.id
        expense_data["date"] = expense.date
        
        return ExpenseResponse(**expense_data)
    
    async def get(self, expense_id: str, family_id: str) -> Optional[ExpenseResponse]:
        """Get an expense by ID."""
        doc = self.collection.document(expense_id).get()
        
        if not doc.exists:
            return None
        
        data = doc.to_dict()
        
        # Verify family ownership
        if data.get("family_id") != family_id:
            return None
        
        data["id"] = doc.id
        # Convert timestamp to date
        if isinstance(data.get("date"), datetime):
            data["date"] = data["date"].date()
        
        return ExpenseResponse(**data)
    
    async def update(
        self, 
        expense_id: str, 
        expense: ExpenseUpdate, 
        family_id: str
    ) -> Optional[ExpenseResponse]:
        """Update an expense."""
        doc_ref = self.collection.document(expense_id)
        doc = doc_ref.get()
        
        if not doc.exists:
            return None
        
        data = doc.to_dict()
        
        # Verify family ownership
        if data.get("family_id") != family_id:
            return None
        
        # Build update data
        update_data = {
            k: v for k, v in expense.model_dump().items() 
            if v is not None
        }
        
        if "date" in update_data:
            update_data["date"] = datetime.combine(
                update_data["date"], 
                datetime.min.time()
            )
        
        update_data["updated_at"] = datetime.utcnow()
        
        doc_ref.update(update_data)
        
        # Get updated document
        return await self.get(expense_id, family_id)
    
    async def delete(self, expense_id: str, family_id: str) -> bool:
        """Delete an expense."""
        doc_ref = self.collection.document(expense_id)
        doc = doc_ref.get()
        
        if not doc.exists:
            return False
        
        data = doc.to_dict()
        
        # Verify family ownership
        if data.get("family_id") != family_id:
            return False
        
        doc_ref.delete()
        return True
    
    async def list(
        self,
        family_id: str,
        filters: Optional[ExpenseFilters] = None,
        page: int = 1,
        page_size: int = 20,
    ) -> Tuple[List[ExpenseResponse], int, bool]:
        """
        List expenses for a family with optional filters.
        
        Returns:
            Tuple of (expenses, total_count, has_more)
        """
        query = self.collection.where(
            filter=FieldFilter("family_id", "==", family_id)
        )
        
        # Apply filters
        if filters:
            if filters.start_date:
                start_dt = datetime.combine(filters.start_date, datetime.min.time())
                query = query.where(filter=FieldFilter("date", ">=", start_dt))
            
            if filters.end_date:
                end_dt = datetime.combine(filters.end_date, datetime.max.time())
                query = query.where(filter=FieldFilter("date", "<=", end_dt))
            
            if filters.category:
                query = query.where(
                    filter=FieldFilter("category", "==", filters.category.value)
                )
            
            if filters.beneficiary:
                query = query.where(
                    filter=FieldFilter("beneficiary", "==", filters.beneficiary)
                )
            
            if filters.payment_method:
                query = query.where(
                    filter=FieldFilter("payment_method", "==", filters.payment_method.value)
                )
        
        # Order by date descending
        query = query.order_by("date", direction="DESCENDING")
        
        # Get total count (separate query)
        count_query = query.count()
        count_result = count_query.get()
        total = count_result[0][0].value
        
        # Apply pagination
        offset = (page - 1) * page_size
        query = query.offset(offset).limit(page_size + 1)  # +1 to check has_more
        
        # Execute query
        docs = query.stream()
        
        expenses = []
        for doc in docs:
            data = doc.to_dict()
            data["id"] = doc.id
            
            # Convert timestamp to date
            if isinstance(data.get("date"), datetime):
                data["date"] = data["date"].date()
            
            expenses.append(ExpenseResponse(**data))
        
        # Check if there are more results
        has_more = len(expenses) > page_size
        if has_more:
            expenses = expenses[:page_size]
        
        return expenses, total, has_more
    
    async def get_summary(
        self,
        family_id: str,
        start_date: date,
        end_date: date,
        beneficiary: Optional[str] = None,
    ) -> ExpenseSummary:
        """Get expense summary for a period."""
        query = self.collection.where(
            filter=FieldFilter("family_id", "==", family_id)
        )
        
        start_dt = datetime.combine(start_date, datetime.min.time())
        end_dt = datetime.combine(end_date, datetime.max.time())
        
        query = query.where(filter=FieldFilter("date", ">=", start_dt))
        query = query.where(filter=FieldFilter("date", "<=", end_dt))
        
        if beneficiary:
            query = query.where(filter=FieldFilter("beneficiary", "==", beneficiary))
        
        docs = query.stream()
        
        total_amount = 0.0
        by_category = {}
        by_beneficiary = {}
        by_payment_method = {}
        expense_count = 0
        
        for doc in docs:
            data = doc.to_dict()
            amount = data.get("amount", 0)
            category = data.get("category", "other")
            benef = data.get("beneficiary", "unknown")
            payment = data.get("payment_method", "other")
            
            total_amount += amount
            expense_count += 1
            
            by_category[category] = by_category.get(category, 0) + amount
            by_beneficiary[benef] = by_beneficiary.get(benef, 0) + amount
            by_payment_method[payment] = by_payment_method.get(payment, 0) + amount
        
        return ExpenseSummary(
            total_amount=total_amount,
            by_category=by_category,
            by_beneficiary=by_beneficiary,
            by_payment_method=by_payment_method,
            expense_count=expense_count,
            period_start=start_date,
            period_end=end_date,
        )
    
    async def get_spending_for_budget(
        self,
        family_id: str,
        start_date: date,
        end_date: date,
        category: Optional[str] = None,
        beneficiary: Optional[str] = None,
        budget_id: Optional[str] = None,
    ) -> float:
        """Get total spending for budget tracking.

        Two sources are summed:
        1. Expenses explicitly pinned to this budget via budget_id (wins regardless of category).
        2. Expenses with no budget_id whose category matches (backward-compat fallback).

        This means existing budgets that predate the budget_id field continue to work
        as before, and newly pinned expenses are correctly attributed even if their
        category differs from the budget's category.
        """
        start_dt = datetime.combine(start_date, datetime.min.time())
        end_dt = datetime.combine(end_date, datetime.max.time())
        total = 0.0

        # Part 1 — explicitly pinned expenses (only when we have a budget_id to pin to).
        # We catch FailedPrecondition (missing composite index) so the function
        # degrades gracefully until the index finishes building. Without this
        # guard, the parent list_with_status() try/except swallowed the error
        # and dropped ALL budgets from the response, producing an empty budgets
        # list on the client.
        if budget_id:
            try:
                pinned_query = (
                    self.collection
                    .where(filter=FieldFilter("family_id", "==", family_id))
                    .where(filter=FieldFilter("budget_id", "==", budget_id))
                    .where(filter=FieldFilter("date", ">=", start_dt))
                    .where(filter=FieldFilter("date", "<=", end_dt))
                )
                if beneficiary:
                    pinned_query = pinned_query.where(filter=FieldFilter("beneficiary", "==", beneficiary))
                for doc in pinned_query.stream():
                    total += doc.to_dict().get("amount", 0)
            except Exception as e:
                # Index missing or other Firestore error — log + continue with
                # only the fallback query. Until anyone actually pins an
                # expense to this budget, the pinned sum is 0 anyway.
                import logging
                logging.getLogger(__name__).warning(
                    "Pinned-budget query failed (likely missing composite index): %s", e
                )

        # Part 2 — unpinned expenses that match by category (fallback / legacy)
        fallback_query = (
            self.collection
            .where(filter=FieldFilter("family_id", "==", family_id))
            .where(filter=FieldFilter("date", ">=", start_dt))
            .where(filter=FieldFilter("date", "<=", end_dt))
        )
        if category:
            fallback_query = fallback_query.where(filter=FieldFilter("category", "==", category))
        if beneficiary:
            fallback_query = fallback_query.where(filter=FieldFilter("beneficiary", "==", beneficiary))

        for doc in fallback_query.stream():
            data = doc.to_dict()
            # Skip expenses that are pinned (already counted in part 1, or pinned to a different budget)
            if data.get("budget_id"):
                continue
            total += data.get("amount", 0)

        return total


# Singleton instance
expense_service = ExpenseService()


def get_expense_service() -> ExpenseService:
    """Get the expense service instance."""
    return expense_service
