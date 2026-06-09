"""Investments router: SnapTrade-backed portfolio endpoints."""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from app.auth.dependencies import get_current_user
from app.models.user import User
from app.services import snaptrade_service

router = APIRouter()


class LoginUrlRequest(BaseModel):
    broker: Optional[str] = "ROBINHOOD"
    custom_redirect: Optional[str] = None
    connection_type: str = "read"


@router.post("/register")
async def register(current_user: User = Depends(get_current_user)):
    """Register the current user with SnapTrade. Idempotent."""
    try:
        return snaptrade_service.register_user(current_user.id)
    except RuntimeError as e:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(e))


@router.post("/connect")
async def connect(
    req: LoginUrlRequest,
    current_user: User = Depends(get_current_user),
):
    """Generate a Connection Portal URL for the user to link a brokerage (default Robinhood)."""
    return snaptrade_service.login_url(
        current_user.id,
        broker=req.broker,
        custom_redirect=req.custom_redirect,
        connection_type=req.connection_type,
    )


@router.get("/accounts")
async def accounts(current_user: User = Depends(get_current_user)):
    return snaptrade_service.list_accounts(current_user.id)


@router.get("/holdings")
async def holdings(current_user: User = Depends(get_current_user)):
    return snaptrade_service.get_all_holdings(current_user.id)


@router.get("/accounts/{account_id}/balances")
async def balances(account_id: str, current_user: User = Depends(get_current_user)):
    return snaptrade_service.get_account_balances(current_user.id, account_id)


@router.get("/accounts/{account_id}/positions")
async def positions(account_id: str, current_user: User = Depends(get_current_user)):
    return snaptrade_service.get_account_positions(current_user.id, account_id)


@router.get("/activities")
async def activities(
    start_date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    end_date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    accounts: Optional[str] = Query(None, description="Comma-separated account UUIDs"),
    current_user: User = Depends(get_current_user),
):
    return snaptrade_service.get_activities(
        current_user.id, start_date=start_date, end_date=end_date, accounts=accounts,
    )


@router.post("/snapshot")
async def snapshot(current_user: User = Depends(get_current_user)):
    """Persist a dated snapshot of current holdings to Firestore (for analysis)."""
    doc_id = snaptrade_service.snapshot_holdings(current_user.id)
    return {"snapshot_id": doc_id}


@router.delete("/registration")
async def deregister(current_user: User = Depends(get_current_user)):
    return snaptrade_service.delete_user(current_user.id)
