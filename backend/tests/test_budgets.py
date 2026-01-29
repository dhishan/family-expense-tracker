"""Tests for budget functionality."""
import pytest
from datetime import date, timedelta

from app.models.budget import BudgetPeriod
from app.services.budget_service import BudgetService


class TestBudgetService:
    """Test budget service functionality."""
    
    def test_get_weekly_period_dates(self):
        """Test getting weekly period dates."""
        service = BudgetService.__new__(BudgetService)
        
        # Test with a known Wednesday (2026-01-28)
        test_date = date(2026, 1, 28)
        start, end = service._get_period_dates(BudgetPeriod.WEEKLY, test_date)
        
        # Week should start on Monday (26th) and end on Sunday (Feb 1st)
        assert start == date(2026, 1, 26)
        assert end == date(2026, 2, 1)
    
    def test_get_monthly_period_dates(self):
        """Test getting monthly period dates."""
        service = BudgetService.__new__(BudgetService)
        
        # Test with January 28, 2026
        test_date = date(2026, 1, 28)
        start, end = service._get_period_dates(BudgetPeriod.MONTHLY, test_date)
        
        assert start == date(2026, 1, 1)
        assert end == date(2026, 1, 31)
    
    def test_get_monthly_period_december(self):
        """Test getting monthly period dates for December."""
        service = BudgetService.__new__(BudgetService)
        
        test_date = date(2025, 12, 15)
        start, end = service._get_period_dates(BudgetPeriod.MONTHLY, test_date)
        
        assert start == date(2025, 12, 1)
        assert end == date(2025, 12, 31)


class TestBudgetModels:
    """Test budget models."""
    
    def test_budget_period_enum(self):
        """Test budget period enum values."""
        assert BudgetPeriod.WEEKLY.value == "weekly"
        assert BudgetPeriod.MONTHLY.value == "monthly"
