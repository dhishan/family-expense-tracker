# Family Expense Tracker - Development Context

## Project Overview
A family expense tracking application hosted on GCP that allows family members to track daily spending, tag expenses, and manage budgets.

## Tech Stack
- **Frontend**: React (TypeScript), Vite, TailwindCSS
- **Backend**: Python (FastAPI)
- **Database**: Firestore (Native mode)
- **Infrastructure**: GCP Cloud Run, Cloud Storage, Terraform
- **Authentication**: Google OAuth 2.0
- **Local Development**: Docker Compose
- **CI/CD**: GitHub Actions

## Domain Configuration
- Root Domain: `blueelephants.org`
- Frontend: `app.blueelephants.org`
- Backend API: `api.blueelephants.org`

---

## Requirements Summary

### Users & Family Structure
- [x] Initial users: 2 (user + spouse)
- [x] Support creating "family/group" for inviting additional members
- [x] All members have equal permissions (add/edit/delete expenses, view shared data, manage budgets)
- [x] Expenses are part of shared family workspace

### Expense Entry (Phase 1 - Manual)
- [x] Amount
- [x] Date
- [x] Description
- [x] Merchant
- [x] Payment Method
- [ ] Receipt uploads (future enhancement)

### Tagging System
- [x] Categories: Groceries, Dining, Transportation, Utilities, Entertainment
- [x] "Who is it for": Individual family member OR entire family
- [x] System should be extensible for future tag dimensions

### Budgeting
- [x] Budget by category
- [x] Budget by time period (weekly/monthly)
- [x] Budget by person
- [x] In-app notifications when approaching/exceeding limits

### Credit Card Auto-Import (Phase 2 - Future)
- [ ] American Express
- [ ] Chase
- [ ] PayPal
- [ ] Citi
- [ ] Best Buy
- [ ] Macy's
- Note: Will need Plaid/Yodlee integration

### Non-Functional Requirements
- [x] Google OAuth only (any Google account can sign up)
- [x] Data encrypted at rest (Firestore default)
- [x] Mobile-responsive web (no PWA needed)
- [x] Unit tests for core features
- [x] GitHub Actions CI/CD
- [x] Same GCP project for dev/prod environments

---

## Data Models

### Family (Collection: `families`)
```
{
  id: string (auto-generated)
  name: string
  created_at: timestamp
  created_by: string (user_id)
  invite_code: string (for inviting members)
}
```

### User (Collection: `users`)
```
{
  id: string (Google UID)
  email: string
  display_name: string
  photo_url: string
  family_id: string (reference to family)
  created_at: timestamp
  updated_at: timestamp
}
```

### Expense (Collection: `expenses`)
```
{
  id: string (auto-generated)
  family_id: string
  amount: number
  currency: string (default: USD)
  date: timestamp
  description: string
  merchant: string
  payment_method: string (cash, credit, debit, etc.)
  category: string (groceries, dining, transportation, utilities, entertainment)
  beneficiary: string (user_id or "family")
  created_by: string (user_id)
  created_at: timestamp
  updated_at: timestamp
  tags: array<string> (extensible for future)
}
```

### Budget (Collection: `budgets`)
```
{
  id: string (auto-generated)
  family_id: string
  name: string
  amount: number
  period: string (weekly, monthly)
  category: string (optional - null means all categories)
  beneficiary: string (optional - user_id, "family", or null for all)
  start_date: timestamp
  created_by: string (user_id)
  created_at: timestamp
  updated_at: timestamp
}
```

### Notification (Collection: `notifications`)
```
{
  id: string (auto-generated)
  family_id: string
  user_id: string (recipient)
  type: string (budget_warning, budget_exceeded)
  title: string
  message: string
  read: boolean
  created_at: timestamp
  related_budget_id: string (optional)
}
```

---

## API Endpoints

### Authentication
- `POST /auth/google` - Exchange Google token for session
- `GET /auth/me` - Get current user info
- `POST /auth/logout` - Logout

### Family
- `POST /families` - Create new family
- `GET /families/{id}` - Get family details
- `POST /families/{id}/join` - Join family with invite code
- `GET /families/{id}/members` - List family members

### Expenses
- `GET /expenses` - List expenses (with filters)
- `POST /expenses` - Create expense
- `GET /expenses/{id}` - Get expense details
- `PUT /expenses/{id}` - Update expense
- `DELETE /expenses/{id}` - Delete expense
- `GET /expenses/summary` - Get expense summary/analytics

### Budgets
- `GET /budgets` - List budgets
- `POST /budgets` - Create budget
- `GET /budgets/{id}` - Get budget details
- `PUT /budgets/{id}` - Update budget
- `DELETE /budgets/{id}` - Delete budget
- `GET /budgets/{id}/status` - Get budget status (spent vs limit)

### Notifications
- `GET /notifications` - List notifications
- `PUT /notifications/{id}/read` - Mark as read
- `PUT /notifications/read-all` - Mark all as read

---

## Project Structure
```
family-expense-tracker/
├── CONTEXT.md                 # This file
├── README.md                  # Project documentation
├── Makefile                   # Build/deploy commands
├── docker-compose.yml         # Local development
├── .github/
│   └── workflows/
│       └── ci-cd.yml          # GitHub Actions
├── backend/
│   ├── Dockerfile
│   ├── Dockerfile.local
│   ├── requirements.txt
│   ├── .env.example
│   ├── app/
│   │   ├── __init__.py
│   │   ├── main.py            # FastAPI app
│   │   ├── config.py          # Configuration
│   │   ├── auth/
│   │   │   ├── __init__.py
│   │   │   ├── google.py      # Google OAuth
│   │   │   └── dependencies.py
│   │   ├── models/
│   │   │   ├── __init__.py
│   │   │   ├── user.py
│   │   │   ├── family.py
│   │   │   ├── expense.py
│   │   │   ├── budget.py
│   │   │   └── notification.py
│   │   ├── routers/
│   │   │   ├── __init__.py
│   │   │   ├── auth.py
│   │   │   ├── families.py
│   │   │   ├── expenses.py
│   │   │   ├── budgets.py
│   │   │   └── notifications.py
│   │   ├── services/
│   │   │   ├── __init__.py
│   │   │   ├── firestore.py
│   │   │   ├── expense_service.py
│   │   │   ├── budget_service.py
│   │   │   └── notification_service.py
│   │   └── utils/
│   │       ├── __init__.py
│   │       └── helpers.py
│   └── tests/
│       ├── __init__.py
│       ├── conftest.py
│       ├── test_expenses.py
│       └── test_budgets.py
├── frontend/
│   ├── Dockerfile
│   ├── package.json
│   ├── vite.config.ts
│   ├── tailwind.config.js
│   ├── tsconfig.json
│   ├── index.html
│   ├── .env.example
│   ├── public/
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── index.css
│       ├── components/
│       │   ├── Layout/
│       │   ├── Expenses/
│       │   ├── Budgets/
│       │   └── common/
│       ├── pages/
│       │   ├── Dashboard.tsx
│       │   ├── Expenses.tsx
│       │   ├── Budgets.tsx
│       │   ├── Settings.tsx
│       │   └── Login.tsx
│       ├── hooks/
│       ├── services/
│       │   └── api.ts
│       ├── store/
│       │   └── auth.ts
│       ├── types/
│       │   └── index.ts
│       └── utils/
└── terraform/
    ├── main/
    │   ├── main.tf
    │   ├── variables.tf
    │   ├── outputs.tf
    │   ├── provider.tf
    │   ├── firestore_rules.tf
    │   └── firestore_indexes.tf
    └── workspaces/
        └── dev/
            ├── backend.conf
            └── terraform.tfvars
```

---

## Development Progress

### Phase 1: Foundation ✅
- [x] Project structure setup
- [x] Backend API skeleton
- [x] Frontend skeleton
- [x] Docker Compose setup
- [x] Google OAuth integration
- [x] Firestore connection

### Phase 2: Core Features ✅
- [x] Family creation/joining
- [x] Expense CRUD
- [x] Expense listing with filters
- [x] Basic dashboard

### Phase 3: Budgeting ✅
- [x] Budget CRUD
- [x] Budget tracking
- [x] In-app notifications

### Phase 4: Polish ✅
- [x] Analytics/charts
- [x] Mobile responsiveness
- [x] Unit tests
- [x] CI/CD pipeline

### Phase 5: Infrastructure ✅
- [x] Terraform updates
- [x] Domain configuration
- [ ] Production deployment (manual step)

---

## Environment Variables

### Backend
```
GCP_PROJECT_ID=personal-projects-473219
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
JWT_SECRET_KEY=your-jwt-secret-key
FIRESTORE_DATABASE=family-expense-tracker-dev
ENVIRONMENT=development
FRONTEND_URL=http://localhost:5173
```

### Frontend
```
VITE_API_URL=http://localhost:8000
VITE_GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
```

---

## Notes & Decisions

1. **Firestore over Cloud SQL**: Chosen for simplicity, free tier, and good fit for document-based expense data
2. **FastAPI over Flask**: Better async support, automatic OpenAPI docs, type hints
3. **Vite over CRA**: Faster development, better build times
4. **TailwindCSS**: Rapid UI development, good for responsive design
5. **No email allowlist**: Open registration with Google OAuth (can add restrictions later)

---

## Current Session Progress

- [x] Requirements gathering complete
- [x] Creating project structure
- [x] Building backend (FastAPI with all models, services, routers)
- [x] Building frontend (React with all pages and components)
- [x] Docker Compose setup
- [x] Terraform configuration updated
- [x] GitHub Actions CI/CD workflow

Last Updated: 2025-01-28
