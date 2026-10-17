# Deploying to Railway (one project, three services + two databases)

Both apps ship a `Dockerfile` and `railway.json`; Railway picks them up automatically.
The backend service runs **migrations, the API and the email worker together** (`backend/scripts/start.js`),
so you do not need a separate worker service.

## 1. Create the project
1. Railway → **New Project → Deploy from GitHub repo** (this repo).
2. In the project add **+ New → Database → PostgreSQL** and **+ New → Database → Redis**.

## 2. Backend service
Service → Settings → **Root Directory = `backend`**. Leave Build/Start commands empty (the Dockerfile owns them).
Service → Settings → **Networking → Generate Domain** (e.g. `https://api-xxxx.up.railway.app`).

Variables (Variables tab → *Raw Editor*; names `Postgres`/`Redis` must match your database service names):

```
NODE_ENV=production
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
FRONTEND_URL=https://<your-frontend-domain>
SESSION_SECRET=<openssl rand -hex 32>
TOKEN_ENCRYPTION_KEY=<openssl rand -hex 32, a different value>
GOOGLE_CLIENT_ID=<from Google Cloud>
GOOGLE_CLIENT_SECRET=<from Google Cloud>
GOOGLE_CALLBACK_URL=https://<backend-domain>/api/auth/google/callback
ETHEREAL_HOST=...   ETHEREAL_PORT=...   ETHEREAL_USER=...   ETHEREAL_PASS=...
BULL_BOARD_ADMIN_EMAILS=you@gmail.com
ELASTICSEARCH_URL=<optional, see below>
```
- Do **not** set `PORT` (Railway sets it).
- Ethereal credentials: run `cd backend && node scripts/create-ethereal.js` once and paste its output.
  All four values are required in production.
- Google: Google Cloud Console → APIs & Services → Credentials → OAuth client (Web). Add the exact
  `GOOGLE_CALLBACK_URL` above as an *Authorized redirect URI*.
- Elasticsearch is optional: the API stays up (health = `degraded`) without it. Point `ELASTICSEARCH_URL`
  at a hosted cluster to enable search.
- Slack (optional): `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_REDIRECT_URI` — all three or none.

If a variable is missing, the deploy log prints a clear list of what to set (it does not crash-loop silently).

## 3. Frontend service
Add another service from the same repo → **Root Directory = `frontend`** → Generate Domain.

Variable (set **before** the first build; it is baked into the bundle):
```
NEXT_PUBLIC_API_BASE_URL=https://<backend-domain>
```
Then put the frontend domain into the backend's `FRONTEND_URL` and redeploy the backend.

## 4. Check
`https://<backend-domain>/api/health` → `{"status":"ok"|"degraded", ...}` with postgres and redis `up`.

## Scaling note
To run the worker as its own service instead, set `RUN_WORKER=false` on the API service and create a second
service from `backend` with `START_MODE=worker`.
