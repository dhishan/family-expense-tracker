"""Main FastAPI application."""
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.mcp_server import build_mcp_app, mcp
from app.routers import auth, families, expenses, budgets, notifications, investments, chat

settings = get_settings()


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

# Configure CORS
cors_origins = [
    settings.frontend_url,
    "http://localhost:5173",
    "http://localhost:3000",
]

if settings.environment == "production":
    cors_origins.extend([
        "https://ui.expense-tracker.blueelephants.org",
        "https://blueelephants.org",
    ])

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

# Mount hosted MCP server at /mcp (Streamable HTTP transport).
# Auth: Cloudflare Access JWT (prod) | Bearer JWT (fallback) | X-Mcp-User-Id (dev only).
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
