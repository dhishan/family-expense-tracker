"""Main FastAPI application."""
import os
from contextlib import asynccontextmanager

import sentry_sdk
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.mcp_server import build_mcp_app, mcp
from app.routers import auth, families, expenses, budgets, notifications, investments, chat, plaid, rules, usage, wellknown

settings = get_settings()

_SENTRY_DSN = os.environ.get("SENTRY_DSN")
if _SENTRY_DSN:
    sentry_sdk.init(
        dsn=_SENTRY_DSN,
        traces_sample_rate=0.05,
        environment=settings.environment,
        send_default_pii=False,
        release=os.environ.get("SENTRY_RELEASE") or os.environ.get("K_REVISION") or "backend@dev",
    )


def _enforce_production_jwt_secret() -> None:
    """Refuse to boot if production is running with the hardcoded default
    JWT secret. A weak or default signing key lets anyone forge a JWT for
    any user — see docs/security-review-2026-06-15.md (Critical finding).
    """
    # Skip the guard in local dev + test/e2e sandboxes. Production
    # (environment="production") must provide a real secret. Note: our
    # Cloud Run deploys use environment="dev" but DO have a strong
    # JWT_SECRET_KEY injected via Secret Manager — the guard correctly
    # passes there because the secret is real, not because env was
    # whitelisted.
    if settings.environment in ("development", "test", "sandbox", "e2e"):
        return
    sec = settings.effective_jwt_secret()
    if not sec or sec == "change-me-in-production" or len(sec) < 32:
        raise RuntimeError(
            "Refusing to start: JWT signing secret is missing, the hardcoded "
            "default, or too short (<32 chars). Set JWT_SECRET_KEY (or "
            "SECRET_KEY) to a random 32+ byte value in the Cloud Run env."
        )


_enforce_production_jwt_secret()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Start the MCP server's session manager alongside FastAPI."""
    async with mcp.session_manager.run():
        yield


app = FastAPI(
    title="Family Expense Tracker API",
    description="API for tracking family expenses, budgets, and financial insights",
    version="1.0.0",
    docs_url="/docs" if settings.environment == "development" else None,
    redoc_url="/redoc" if settings.environment == "development" else None,
    lifespan=lifespan,
)

# Configure CORS. The production origins are added unconditionally: the
# deployed service runs with ENVIRONMENT=dev, so gating them on
# `environment == "production"` (as before) meant they were never applied and
# the apex domain got CORS-blocked in production.
cors_origins = [
    settings.frontend_url,
    "http://localhost:5173",
    "http://localhost:3000",
    "https://ui.expense-tracker.blueelephants.org",
    "https://blueelephants.org",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(auth.router, prefix=f"{settings.api_prefix}/auth", tags=["Authentication"])
app.include_router(families.router, prefix=f"{settings.api_prefix}/families", tags=["Families"])
app.include_router(expenses.router, prefix=f"{settings.api_prefix}/expenses", tags=["Expenses"])
app.include_router(budgets.router, prefix=f"{settings.api_prefix}/budgets", tags=["Budgets"])
app.include_router(notifications.router, prefix=f"{settings.api_prefix}/notifications", tags=["Notifications"])
app.include_router(investments.router, prefix=f"{settings.api_prefix}/investments", tags=["Investments"])
app.include_router(chat.router, prefix=f"{settings.api_prefix}/chat", tags=["Chat"])
app.include_router(plaid.router, prefix=f"{settings.api_prefix}/plaid", tags=["Plaid"])
app.include_router(rules.router, prefix=f"{settings.api_prefix}/rules", tags=["Rules"])
app.include_router(usage.router, prefix=f"{settings.api_prefix}/usage", tags=["Usage"])

# OAuth metadata for MCP client discovery (claude.ai / chatgpt.com connectors).
# Must serve at the literal /.well-known/... paths — no prefix.
app.include_router(wellknown.router, tags=["Well-known"])


@app.middleware("http")
async def _mcp_trailing_slash(request, call_next):
    """FastAPI's default 307 on missing trailing slash breaks POSTs from
    claude.ai/chatgpt — many clients drop auth headers or refuse to follow
    a 307 with a body. Rewrite /mcp -> /mcp/ in-place so the mount handles
    it without a redirect round-trip."""
    if request.url.path == "/mcp":
        request.scope["path"] = "/mcp/"
        request.scope["raw_path"] = b"/mcp/"
    return await call_next(request)

# Mount hosted MCP server at /mcp (Streamable HTTP transport).
# Auth: Google OAuth bearer (prod) | X-Mcp-User-Id (dev only).
# Session manager is started by the lifespan above.
app.mount("/mcp", build_mcp_app())


@app.get("/")
async def root():
    """Root endpoint."""
    return {
        "name": "Family Expense Tracker API",
        "version": "1.0.0",
        "status": "healthy",
    }


@app.get("/health")
async def health_check():
    """Health check endpoint for Cloud Run."""
    return {"status": "healthy"}
