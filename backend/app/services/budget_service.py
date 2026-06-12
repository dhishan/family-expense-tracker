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
        elif period == BudgetPeriod.YEARLY:
            # Calendar year — Jan 1 through Dec 31 of the reference year.
            # This is the simplest model and matches how most personal-finance
            # tools think about "annual" budgets (e.g. travel, gifts, charity).
            # If we ever want fiscal-year or rolling-12-month, add a separate
            # period type rather than overloading this one.
            start = ref.replace(month=1, day=1)
            end = ref.replace(month=12, day=31)
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
        family_id: str,
        reference_date: Optional[date] = None,
    ) -> Optional[BudgetStatus]:
        """Get budget status with spending info."""
        budget = await self.get(budget_id, family_id)

        if not budget:
            return None

        # Get current period dates — use client's local date when provided
        period = BudgetPeriod(budget.period)
        period_start, period_end = self._get_period_dates(period, reference_date=reference_date)

        # Normalize the budget's beneficiary before passing it down.
        # A budget with beneficiary in {None, "", "family", "Family"} is
        # family-wide and should count every member's spending, not filter
        # for expenses whose beneficiary string literally equals "family".
        bud_beneficiary = budget.beneficiary
        if bud_beneficiary in (None, "", "family", "Family"):
            bud_beneficiary = None

        # Run current-period spending and rollover query in parallel —
        # they don't depend on each other.
        import asyncio
        expense_service = get_expense_service()
        spent, rollover_amount = await asyncio.gather(
            expense_service.get_spending_for_budget(
                family_id=family_id,
                start_date=period_start,
                end_date=period_end,
                category=budget.category,
                beneficiary=bud_beneficiary,
                budget_id=budget.id,
            ),
            self._compute_rollover(
                budget=budget,
                current_period_start=period_start,
                family_id=family_id,
                bud_beneficiary=bud_beneficiary,
            ),
        )

        effective_amount = budget.amount + rollover_amount
        remaining = effective_amount - spent
        percentage_used = (spent / effective_amount * 100) if effective_amount > 0 else 0

        return BudgetStatus(
            budget=budget,
            spent=spent,
            remaining=remaining,
            percentage_used=round(percentage_used, 2),
            is_over_budget=spent > effective_amount,
            period_start=period_start,
            period_end=period_end,
            rollover_amount=round(rollover_amount, 2),
            effective_amount=round(effective_amount, 2),
        )

    def _count_periods(self, period: BudgetPeriod, start: date, current_period_start: date) -> int:
        """Count complete elapsed periods between budget.start_date and the
        current period's start. Returns 0 if start_date is after current."""
        if current_period_start <= start:
            return 0
        if period == BudgetPeriod.WEEKLY:
            return max(0, (current_period_start - start).days // 7)
        elif period == BudgetPeriod.YEARLY:
            return max(0, current_period_start.year - start.year)
        else:  # MONTHLY
            return max(0, (current_period_start.year - start.year) * 12 + (current_period_start.month - start.month))

    async def _compute_rollover(
        self,
        *,
        budget,
        current_period_start: date,
        family_id: str,
        bud_beneficiary: Optional[str],
    ) -> float:
        """Cumulative uncapped rollover: unused budget from all prior periods
        since budget.start_date carries forward.

        Implementation note: we compute it as
            total_past_budget = budget.amount * periods_elapsed
            past_spent        = single Firestore range query
            rollover          = max(0, total_past_budget - past_spent)

        This is a single Firestore read regardless of how many periods have
        elapsed. Tradeoff: a "$150 over in week 3, $0 spent in weeks 4-10"
        pattern shows up as one combined deficit/surplus rather than per-week
        crediting back the overspend. For v1 this is acceptable; we can move
        to per-period bucketing later if anyone complains.
        """
        if not getattr(budget, "rollover_enabled", True):
            return 0.0
        periods_elapsed = self._count_periods(
            BudgetPeriod(budget.period), budget.start_date, current_period_start
        )
        if periods_elapsed <= 0:
            return 0.0

        from datetime import timedelta as _td
        past_end = current_period_start - _td(days=1)

        expense_service = get_expense_service()
        past_spent = await expense_service.get_spending_for_budget(
            family_id=family_id,
            start_date=budget.start_date,
            end_date=past_end,
            category=budget.category,
            beneficiary=bud_beneficiary,
            budget_id=budget.id,
        )
        total_past_budget = budget.amount * periods_elapsed
        return max(0.0, total_past_budget - past_spent)

    async def list_expenses_for_budget(
        self,
        budget_id: str,
        family_id: str,
        scope: str = "current",
        reference_date: Optional[date] = None,
    ) -> Optional[List[dict]]:
        """All expenses that count toward this budget.

        scope='current' → current period only (matches the budget card's spent number)
        scope='all'     → since budget.start_date (the full rollover-inclusive view)
        """
        budget = await self.get(budget_id, family_id)
        if not budget:
            return None

        if scope == "all":
            start = budget.start_date
            _, end = self._get_period_dates(BudgetPeriod(budget.period), reference_date=reference_date)
        else:
            start, end = self._get_period_dates(BudgetPeriod(budget.period), reference_date=reference_date)

        bud_beneficiary = budget.beneficiary
        if bud_beneficiary in (None, "", "family", "Family"):
            bud_beneficiary = None

        from datetime import datetime as _dt
        start_dt = _dt.combine(start, _dt.min.time())
        end_dt = _dt.combine(end, _dt.max.time())

        # Mirror get_spending_for_budget's two-source union (pinned + category fallback)
        # but return the actual docs rather than just summing amounts.
        seen: set[str] = set()
        items: list[dict] = []

        # Pinned
        try:
            pinned_query = (
                self.db.collection("expenses")
                .where(filter=FieldFilter("family_id", "==", family_id))
                .where(filter=FieldFilter("budget_id", "==", budget_id))
                .where(filter=FieldFilter("date", ">=", start_dt))
                .where(filter=FieldFilter("date", "<=", end_dt))
            )
            if bud_beneficiary:
                pinned_query = pinned_query.where(filter=FieldFilter("beneficiary", "==", bud_beneficiary))
            for doc in pinned_query.stream():
                if doc.id in seen:
                    continue
                d = doc.to_dict() or {}
                d["id"] = doc.id
                items.append(d)
                seen.add(doc.id)
        except Exception:
            pass

        # Category fallback (unpinned only — pinned ones were captured above)
        fallback_query = (
            self.db.collection("expenses")
            .where(filter=FieldFilter("family_id", "==", family_id))
            .where(filter=FieldFilter("date", ">=", start_dt))
            .where(filter=FieldFilter("date", "<=", end_dt))
        )
        if budget.category:
            fallback_query = fallback_query.where(filter=FieldFilter("category", "==", budget.category))
        if bud_beneficiary:
            fallback_query = fallback_query.where(filter=FieldFilter("beneficiary", "==", bud_beneficiary))
        for doc in fallback_query.stream():
            d = doc.to_dict() or {}
            if d.get("budget_id"):
                continue  # pinned to some budget — only the pinned query above counts these
            if doc.id in seen:
                continue
            d["id"] = doc.id
            items.append(d)
            seen.add(doc.id)

        # Newest first; serialize datetimes as iso strings
        def _ser(v):
            if hasattr(v, "isoformat"):
                return v.isoformat()
            return v
        items.sort(key=lambda x: x.get("date") or "", reverse=True)
        for d in items:
            for k in list(d.keys()):
                d[k] = _ser(d[k])
        return items

    async def list_with_status(self, family_id: str, reference_date: Optional[date] = None) -> List[BudgetStatus]:
        """List all budgets with their current status.

        Fans out per-budget status calls in parallel. We already have the
        Budget objects from self.list(), so we pass them directly to
        _status_for_budget instead of having each get_status re-fetch its
        own doc. Saves N redundant single-doc reads on every dashboard
        load.
        """
        import asyncio
        budgets = await self.list(family_id)

        results = await asyncio.gather(
            *[self._status_for_budget(b, family_id, reference_date=reference_date) for b in budgets],
            return_exceptions=True,
        )
        return [s for s in results if isinstance(s, BudgetStatus)]

    async def _status_for_budget(
        self,
        budget: BudgetResponse,
        family_id: str,
        reference_date: Optional[date] = None,
    ) -> Optional[BudgetStatus]:
        """Status from an already-loaded Budget. Same body as get_status,
        but skips the redundant single-doc fetch.
        """
        period = BudgetPeriod(budget.period)
        period_start, period_end = self._get_period_dates(period, reference_date=reference_date)
        bud_beneficiary = budget.beneficiary
        if bud_beneficiary in (None, "", "family", "Family"):
            bud_beneficiary = None

        import asyncio
        expense_service = get_expense_service()
        spent, rollover_amount = await asyncio.gather(
            expense_service.get_spending_for_budget(
                family_id=family_id,
                start_date=period_start,
                end_date=period_end,
                category=budget.category,
                beneficiary=bud_beneficiary,
                budget_id=budget.id,
            ),
            self._compute_rollover(
                budget=budget,
                current_period_start=period_start,
                family_id=family_id,
                bud_beneficiary=bud_beneficiary,
            ),
        )
        effective_amount = budget.amount + rollover_amount
        remaining = effective_amount - spent
        percentage_used = (spent / effective_amount * 100) if effective_amount > 0 else 0
        return BudgetStatus(
            budget=budget,
            spent=spent,
            remaining=remaining,
            percentage_used=round(percentage_used, 2),
            is_over_budget=spent > effective_amount,
            period_start=period_start,
            period_end=period_end,
            rollover_amount=round(rollover_amount, 2),
            effective_amount=round(effective_amount, 2),
        )
    
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
