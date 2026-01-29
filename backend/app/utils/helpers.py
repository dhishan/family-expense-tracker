"""Utility functions."""
from datetime import date, datetime, timedelta
from typing import Tuple


def get_week_range(reference_date: date = None) -> Tuple[date, date]:
    """
    Get the start and end dates of the week containing the reference date.
    Week starts on Monday.
    
    Args:
        reference_date: The reference date (defaults to today)
        
    Returns:
        Tuple of (start_date, end_date)
    """
    ref = reference_date or date.today()
    start = ref - timedelta(days=ref.weekday())
    end = start + timedelta(days=6)
    return start, end


def get_month_range(reference_date: date = None) -> Tuple[date, date]:
    """
    Get the start and end dates of the month containing the reference date.
    
    Args:
        reference_date: The reference date (defaults to today)
        
    Returns:
        Tuple of (start_date, end_date)
    """
    ref = reference_date or date.today()
    start = ref.replace(day=1)
    
    # Get last day of month
    if ref.month == 12:
        end = ref.replace(year=ref.year + 1, month=1, day=1) - timedelta(days=1)
    else:
        end = ref.replace(month=ref.month + 1, day=1) - timedelta(days=1)
    
    return start, end


def format_currency(amount: float, currency: str = "USD") -> str:
    """
    Format a currency amount.
    
    Args:
        amount: The amount to format
        currency: Currency code (default: USD)
        
    Returns:
        Formatted currency string
    """
    if currency == "USD":
        return f"${amount:,.2f}"
    else:
        return f"{amount:,.2f} {currency}"


def calculate_percentage(part: float, whole: float) -> float:
    """
    Calculate percentage.
    
    Args:
        part: The part value
        whole: The whole value
        
    Returns:
        Percentage value (0-100)
    """
    if whole == 0:
        return 0.0
    return round((part / whole) * 100, 2)
