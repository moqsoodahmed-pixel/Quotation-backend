# Quotation Backend

Express + MongoDB API for the LauncherDesk / DutyLaunch / Office Restore
quotation maker.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `MONGO_URI` | **yes** | — | MongoDB connection string |
| `JWT_SECRET` | **yes** | — | Secret for signing JWT tokens (≥32 random chars) |
| `ADMIN_USER` | **yes** | — | Login username |
| `ADMIN_PASS` | **yes** | — | Login password |
| `PORT` | no | `4000` | HTTP listen port |
| `DB_NAME` | no | `launcherdesk` | MongoDB database name |
| `ALLOWED_ORIGINS` | no | `http://localhost:5173` | Comma-separated CORS origins |

## Running locally

```bash
export MONGO_URI=mongodb://127.0.0.1:27017
export JWT_SECRET=$(openssl rand -hex 32)
export ADMIN_USER=admin
export ADMIN_PASS=changeme
npm start
```

## API routes

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/health` | no | Pings Mongo, returns `{ ok }` |
| POST | `/api/login` | no | Returns `{ token }` (JWT, 12h) |
| GET | `/api/quotations` | yes | List (optional `?company=`, `?q=`) |
| GET | `/api/quotations/next-number` | yes | Preview next number (`?company=`) |
| GET | `/api/quotations/:id` | yes | Fetch one |
| POST | `/api/quotations` | yes | Create / update (`{ id?, companyId, data }`) |
| POST | `/api/quotations/:id/duplicate` | yes | Duplicate (`{ companyId? }`) |
| DELETE | `/api/quotations/:id` | yes | Delete |

## Startup tasks (automatic)

1. Drops legacy `quotNo_1` unique index if present
2. Creates indexes: `{companyId, data.quotationNo}` unique + `{companyId, savedAt}`
3. Migrates old docs without `companyId` → `launcherdesk`
4. Seeds yearly counters from highest existing sequence numbers
