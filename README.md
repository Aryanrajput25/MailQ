# MailQ — Full-stack Email Job Scheduler

A production-style email scheduling service and dashboard. Users sign in with Google, compose an email for a list of leads, and the backend schedules one delivery job per recipient on **BullMQ + Redis**, persists everything in **PostgreSQL**, sends through **Ethereal SMTP**, indexes mail into **Elasticsearch**, and posts to **Slack** when a sender's hourly limit is hit.

> **No cron anywhere.** Execution time is owned entirely by BullMQ delayed jobs. The only timers in the codebase are a 30-second *recovery* sweep in the worker (repairs lost queue hand-offs and crashed claims) — they never decide when an email is sent. See [How scheduling works](#1-how-scheduling-works).

**Contents**

1. [Tech stack](#tech-stack)
2. [Project structure](#project-structure)
3. [Quick start](#quick-start)
4. [Environment variables](#environment-variables)
5. [Ethereal SMTP setup](#ethereal-smtp-setup)
6. [Google OAuth, Slack and Elasticsearch setup](#google-oauth-slack-and-elasticsearch-setup)
7. [Architecture](#architecture)
8. [Rate limiting, delay and concurrency](#rate-limiting-delay-and-concurrency)
9. [Behaviour under load](#behaviour-under-load-1000-emails)
10. [Features implemented](#features-implemented)
11. [API reference](#api-reference)
12. [Demo video script](#demo-video)
13. [Tests](#tests)
14. [Deployment](#deployment)
15. [Assumptions, shortcuts and trade-offs](#assumptions-shortcuts-and-trade-offs)

---

## Tech stack

| Layer | Choice |
|---|---|
| Backend | TypeScript, Express 4, Zod validation, Pino logging, Helmet |
| Queue | **BullMQ 6** on **Redis 7** (AOF persistence, `noeviction`) |
| Database | **PostgreSQL 16** via Prisma 6 (driver adapter `pg`) |
| SMTP | **Ethereal Email** through Nodemailer |
| Search | **Elasticsearch 8.15** (versioned index `reachinbox-emails-v1`) |
| Queue UI | **Bull Board** at `/admin/queues` |
| Notifications | **Slack OAuth v2** + `chat.postMessage` |
| Frontend | **Next.js 16** (App Router), React 19, TypeScript, Tailwind CSS 4, SWR, sonner |
| Infra | Docker Compose for PostgreSQL, Redis and Elasticsearch |

## Project structure

```
MailQ/
├── docker-compose.yml          PostgreSQL 16, Redis 7 (AOF), Elasticsearch 8.15
├── RAILWAY.md                  One-go deployment guide
├── backend/
│   ├── prisma/                 schema.prisma + migrations (incl. search-sync trigger)
│   ├── scripts/                start.js (prod entrypoint), create-ethereal.js
│   ├── src/
│   │   ├── app.ts              Express app factory (helmet, credentialed CORS, Origin check)
│   │   ├── server.ts           API process
│   │   ├── worker.ts           BullMQ worker process (+ recovery timers)
│   │   ├── reindex-search.ts   Rebuild Elasticsearch from PostgreSQL
│   │   ├── config/             Zod-validated env, Prisma, Redis clients
│   │   ├── routes/ controllers/ middleware/ schemas/ repositories/ utils/
│   │   ├── queues/email.queue.ts            BullMQ boundary (deterministic job ids)
│   │   ├── workers/email.processor.ts       The delivery state machine
│   │   └── services/
│   │       ├── scheduling.service.ts        Validation, idempotency, transactional write
│   │       ├── hourly-limiter.service.ts    Redis/Lua hourly caps (global/sender/campaign)
│   │       ├── send-throttle.service.ts     Redis/Lua global minimum send interval
│   │       ├── smtp.service.ts              Nodemailer + failure classification
│   │       ├── queue-recovery.service.ts    Outbox drain + stale-claim recovery
│   │       ├── email-search.service.ts      Elasticsearch index/search/reconcile
│   │       ├── slack.service.ts             OAuth, encrypted token, notifications
│   │       └── auth.service.ts              Google OIDC + Redis sessions
│   └── tests/                  19 test files (unit + real PostgreSQL/Redis/SMTP integration)
└── frontend/
    ├── app/                    login, (mail)/scheduled|sent|failed, compose, email/[id]
    ├── components/             auth, compose, mail (rows, states, sidebar), email, ui
    ├── hooks/use-mail.ts       SWR data hooks (5 s auto-refresh)
    └── lib/                    typed api-client, email-service, types, formatters
```

---

## Quick start

**Prerequisites:** Node.js ≥ 20, [pnpm](https://pnpm.io), Docker (≈ 1 GB free RAM for Elasticsearch).
On Linux, Elasticsearch may need `sudo sysctl -w vm.max_map_count=262144`.

### 1. Start infrastructure

```bash
docker compose up -d
```

| Service | Host port | Notes |
|---|---|---|
| PostgreSQL | `5432` | user/password/db: `reachinbox` |
| Redis | `6379` | AOF on (`everysec`), `noeviction` so delayed jobs survive restarts |
| Elasticsearch | **`9201`** → container `9200` | security disabled (local development only) |

> ⚠️ Elasticsearch is published on **9201**, but the backend defaults to `http://localhost:9200`. Set `ELASTICSEARCH_URL=http://localhost:9201` in `backend/.env` (shown below), otherwise `/api/health` reports `degraded` and search falls back to PostgreSQL.

### 2. Backend (API + worker)

```bash
cd backend
cp .env.example .env
```

Edit `backend/.env`. **Generate fresh secrets** (do not reuse any value that ships in `.env.example`):

```bash
openssl rand -hex 32    # → SESSION_SECRET
openssl rand -hex 32    # → TOKEN_ENCRYPTION_KEY   (run again; must be a different value)
```

Minimum local values:

```dotenv
NODE_ENV=development
FRONTEND_URL=http://localhost:3000
DATABASE_URL=postgresql://reachinbox:reachinbox@localhost:5432/reachinbox
REDIS_URL=redis://localhost:6379
ELASTICSEARCH_URL=http://localhost:9201

GOOGLE_CLIENT_ID=...                 # see "Google OAuth" below
GOOGLE_CLIENT_SECRET=...
GOOGLE_CALLBACK_URL=http://localhost:4000/api/auth/google/callback

SESSION_SECRET=<generated>
TOKEN_ENCRYPTION_KEY=<generated>

BULL_BOARD_ADMIN_EMAILS=you@gmail.com   # your Google account; empty = dashboard not mounted
```

Then install, migrate and run **two processes** (API and worker):

```bash
pnpm install                 # also runs `prisma generate`
pnpm prisma:deploy           # applies prisma/migrations (tables + search-sync trigger)

pnpm dev                     # terminal 1 — API on http://localhost:4000  (health: /api/health)
pnpm worker                  # terminal 2 — BullMQ email worker
```

You can run **any number of workers** (`pnpm worker` in several terminals): rate limits and the send interval are enforced through Redis, not process memory.

### 3. Frontend

```bash
cd frontend
echo "NEXT_PUBLIC_API_BASE_URL=http://localhost:4000" > .env.local
pnpm install
pnpm dev                     # http://localhost:3000
```

Use `localhost` for **both** origins (do not mix `localhost` and `127.0.0.1`) — the session cookie is host-scoped and CORS/CSRF checks compare the exact origin.

### 4. Use it

1. Open <http://localhost:3000> → **Continue with Google**.
2. **Compose** → add recipients (type, paste, or **Upload List** with a `.csv`/`.txt`) → subject and body → optionally set *Delay between 2 emails* and *Hourly Limit* → clock icon to pick a **start time** → **Schedule** (or **Send Later** when no time is picked, which queues for immediate delivery).
3. Watch the **Scheduled** and **Sent** tabs update automatically.
4. Queue monitor: <http://localhost:4000/admin/queues> (signed in as an allow-listed admin).
5. Open delivered mail in Ethereal — see below.

### Production-style run

```bash
cd backend  && pnpm build && pnpm prisma:deploy && pnpm start        # API
cd backend  && pnpm start:worker                                      # worker (separate process/service)
cd frontend && pnpm build && pnpm start
```

`backend/scripts/start.js` (used by the Dockerfile) validates env, runs migrations, then starts API **and** worker in one container; set `RUN_WORKER=false` / `START_MODE=worker` to split them. Production mode additionally **requires** Google OAuth, Ethereal credentials and `BULL_BOARD_ADMIN_EMAILS`.

---

## Environment variables

All backend variables live in `backend/.env.example` and are validated at startup with Zod; the process exits with a list of **every** problem. Optional groups (Google, Slack, Ethereal) must be set **completely or not at all**.

| Variable | Default | Meaning |
|---|---|---|
| `NODE_ENV` | `development` | `production` enables Secure cookies and mandatory Google/Ethereal/Bull Board admin |
| `PORT` | `4000` | API port |
| `FRONTEND_URL` | `http://localhost:3000` | Exact frontend origin (CORS + CSRF Origin check + post-login redirect) |
| `DATABASE_URL` | required | PostgreSQL connection string |
| `REDIS_URL` | required | Redis connection string (queue, sessions, limiters) |
| `ELASTICSEARCH_URL` | `http://localhost:9200` | Use `http://localhost:9201` with the bundled Compose file |
| `ELASTICSEARCH_API_KEY` | empty | Optional, for secured clusters |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_CALLBACK_URL` | empty | All three enable Google login. Callback path is `/api/auth/google/callback` |
| `SESSION_SECRET` | required (≥ 32 chars) | Signs the session cookie |
| `TOKEN_ENCRYPTION_KEY` | required (≥ 32 chars) | AES-256-GCM key for stored Slack tokens |
| `ETHEREAL_HOST` / `_PORT` / `_USER` / `_PASS` | empty | SMTP credentials (all four or none). Empty in dev = auto-create a throwaway account |
| **`WORKER_CONCURRENCY`** | `5` | Jobs one worker process runs in parallel |
| **`MIN_DELAY_MS`** | `2000` | **Minimum delay between any two email sends**, across all workers (`0` disables) |
| **`MAX_EMAILS_PER_HOUR`** | `200` | **Global** hourly cap (per UTC clock hour) |
| **`MAX_EMAILS_PER_HOUR_PER_SENDER`** | `100` | **Per-sender** hourly cap (must be ≤ the global cap) |
| `MAX_RECIPIENTS_PER_BATCH` | `1000` | Unique recipients accepted per schedule request |
| `EMAIL_JOB_ATTEMPTS` / `EMAIL_JOB_BACKOFF_MS` | `3` / `5000` | Retries for *transient* SMTP errors; wait = `backoff × 2^(n-1)` |
| `STALE_PROCESSING_MS` | `300000` | A `processing` row older than this is treated as abandoned by a crashed worker |
| `SMTP_TIMEOUT_MS` | `20000` | SMTP connection / greeting / socket timeout |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` / `SLACK_REDIRECT_URI` | empty | All three enable Slack connect + notifications |
| `BULL_BOARD_ADMIN_EMAILS` | empty | Comma-separated Google emails allowed into `/admin/queues`; empty = dashboard not mounted |
| `LOG_LEVEL` | `info` | Pino log level |

Frontend (`frontend/.env.local`, git-ignored):

| Variable | Meaning |
|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | Backend URL, e.g. `http://localhost:4000`. **Baked in at build time.** |

---

## Ethereal SMTP setup

[Ethereal](https://ethereal.email) is a fake SMTP service: it accepts and *captures* mail, nothing reaches a real inbox.

**Option A — fixed account (recommended; lets you log in and see messages)**

```bash
cd backend
node scripts/create-ethereal.js
```

Paste the four printed lines into `backend/.env`:

```dotenv
ETHEREAL_HOST=smtp.ethereal.email
ETHEREAL_PORT=587
ETHEREAL_USER=<printed user>
ETHEREAL_PASS=<printed pass>
```

Then log in at <https://ethereal.email/login> with that user/pass and open **Messages**. (Port 465 uses implicit TLS.)

**Option B — auto-create (development only)**: leave all four `ETHEREAL_*` empty. The worker calls `nodemailer.createTestAccount()` on first send and logs only the host/port. The password is never logged, so use the `previewUrl` instead (below). Refused when `NODE_ENV=production`.

**Finding a sent message.** After SMTP accepts a message the worker stores `smtpMessageId` and `previewUrl` on the `Email` row, and both are returned by `GET /api/emails` / `GET /api/emails/:id`:

```bash
psql "$DATABASE_URL" -c 'select "recipientEmail", status, "previewUrl" from "Email" order by "createdAt" desc limit 5'
```

On startup the worker runs `verify()` (connect + authenticate). In production a failure stops the worker; in development it only warns.

---

## Google OAuth, Slack and Elasticsearch setup

### Google login (required — real OAuth, no mock)

1. Google Cloud Console → **APIs & Services → Credentials → Create OAuth client ID → Web application**.
2. Authorized redirect URI: `http://localhost:4000/api/auth/google/callback` (must equal `GOOGLE_CALLBACK_URL` exactly).
3. Put the client ID/secret into `backend/.env`.

The flow uses the authorization-code grant with **PKCE (S256)**, a one-time Redis-backed `state`, an OIDC `nonce` bound to an HTTP-only browser cookie, and verification of issuer, audience, expiry, nonce, subject and `email_verified`. On success a fresh server-side session is created in Redis (7 days) and the user is redirected to `/scheduled`. There is **no** development or fake-login fallback: without credentials `GET /api/auth/google` returns `503 AUTH_UNAVAILABLE`.

Cookie: HTTP-only, signed, `SameSite=Lax` in development; in production it is `Secure` + `SameSite=None` because the API and frontend are normally on different domains.

### Slack notifications (required — live OAuth + real message)

1. Create a Slack app → **OAuth & Permissions**.
2. Redirect URL: `http://localhost:4000/api/slack/callback` (Slack may insist on HTTPS — if it rejects the localhost URL, use an HTTPS tunnel and set `SLACK_REDIRECT_URI` to match).
3. **Bot token scopes:** `chat:write` and `incoming-webhook`.
4. Set `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_REDIRECT_URI` in `backend/.env`.

In the dashboard: **account menu (sidebar) → Connect Slack** → authorize and pick a channel. The bot token is stored **AES-256-GCM encrypted**, one connection per user. **Disconnect Slack** is in the same menu.

Behaviour:

| Situation | Result |
|---|---|
| Sender's hourly cap is hit and Slack is connected | A real `chat.postMessage` is sent to the chosen channel |
| User never connected Slack / Slack not configured | Notification silently skipped; scheduling and delivery unaffected |
| User connects later | Notifications start working immediately — no redeploy |
| Token revoked | Connection marked revoked; user must reconnect |
| Slack 429 / 5xx / network error | Retried up to 3× (honouring `Retry-After`, capped at 30 s); email stays safely deferred regardless |

Alerts are de-duplicated per **owner + sender + UTC hour** and use a deterministic `client_msg_id`, so BullMQ retries never spam the channel.

> **Important — what triggers Slack.** Slack fires when the **per-sender** cap (`MAX_EMAILS_PER_HOUR_PER_SENDER`) defers an email. The *Hourly Limit* field in the compose form is a **per-campaign** cap and does **not** send Slack alerts; neither does the global cap. To demo it, lower the sender cap — see [Demo video](#demo-video).

### Elasticsearch

Elasticsearch is optional for scheduling/delivery but required for search. The index is created idempotently with a strict mapping on first use. If Elasticsearch is down, scheduling and sending continue and search falls back to a PostgreSQL text search (the response includes `searchSource: "elasticsearch" | "postgres-fallback"`). To rebuild the index from PostgreSQL at any time:

```bash
cd backend && pnpm search:reindex
```

---

## Architecture

```mermaid
flowchart LR
  UI["Next.js dashboard"] -->|"POST /api/emails/schedule"| API["Express API"]
  API -->|"1. one transaction: Campaign + Email rows + QueueOutbox"| PG[("PostgreSQL")]
  API -->|"2. addBulk delayed jobs, jobId = email_id"| RQ[("Redis / BullMQ")]
  RQ -->|"job becomes due"| W["Worker(s)"]
  W -->|"guarded status transitions"| PG
  W -->|"Lua: hourly cap + send slot"| RQ
  W -->|"SMTP"| ETH["Ethereal"]
  W -->|"sender cap hit"| SL["Slack chat.postMessage"]
  PG -->|"trigger writes EmailSearchOutbox"| W
  W -->|"index / retry"| ES[("Elasticsearch")]
  UI -.->|"GET /api/emails?search="| API
  API -.-> ES
```

**Source of truth:** PostgreSQL. Redis (jobs, counters, sessions) and Elasticsearch (search) are derived state that can be rebuilt or re-handed-off.

### 1. How scheduling works

1. `POST /api/emails/schedule` validates the request (every problem is returned at once), sanitizes the HTML, de-duplicates recipients, and opens **one PostgreSQL transaction** that writes the `Sender`, the `Campaign`, one `Email` row per recipient (in chunks of 1000) and one `QueueOutbox` row per email.
2. Recipient *i* gets `scheduledAt = startAt + i × delayBetweenSeconds`. Each email has a time-sortable id and a deterministic `jobId = email_<id>`.
3. After the commit, the API calls `addBulk` to create **BullMQ delayed jobs** (`delay = max(0, scheduledAt − now)`; 3 attempts, exponential backoff) and marks the outbox rows delivered. A `201` therefore means *persisted **and** queued*.
4. If Redis is down at that moment the API returns **`503 QUEUE_UNAVAILABLE`** with `{ persisted: true, recoverable: true }`; nothing is lost — the worker drains the outbox (on startup and every 30 s), and re-sending the same idempotency key is also safe.
5. When a job comes due a worker runs the delivery state machine:

```
scheduled ──claim──▶ processing ──SMTP accepted──▶ sent
    ▲                    │
    └── deferred / transient retry        └──▶ failed (permanent, uncertain, retries exhausted)
```

Every transition is a single guarded `UPDATE … WHERE status = …`, so only one worker can win any step:

| Step | What happens |
|---|---|
| 1. Claim | `scheduled → processing`. A duplicate job loses here and never touches SMTP. Cancelled/sent/failed/missing rows are skipped. A job that fires early re-delays itself to `scheduledAt`. |
| 2. Hourly capacity | Atomic Redis/Lua reservation (global + sender + campaign). Denied → row returns to `scheduled` with `scheduledAt` moved to the next UTC hour, job moved there with BullMQ `moveToDelayed`. |
| 3. Send interval | Atomic Redis/Lua slot. Denied → claim released, job delayed by the exact remaining wait. |
| 4. Record attempt | `attemptCount++`, `smtpAttemptedAt = now` (deferrals never count as attempts). |
| 5. Send → record | SMTP send; `sent` is written **only after** the server accepted the message. |

### 2. How persistence on restart is handled

| Failure | What survives / what recovers |
|---|---|
| **API restarts** | Nothing in memory matters; jobs already live in Redis. |
| **Worker restarts** | Un-started jobs stay in Redis (AOF-persisted). A graceful stop (`SIGTERM`) lets in-flight jobs finish. |
| **Worker crashes mid-job** | BullMQ redelivers after the 30 s lock expires (`maxStalledCount: 1`). The row is reclaimed **only if `smtpAttemptedAt` is NULL** (SMTP never started). |
| **Crash during the SMTP call** | Outcome is unknowable, so the email is marked `failed` with `UNCERTAIN: …` and its Message-ID and is **never auto-resent** (at-most-once beats a duplicate). |
| **Redis restarts** | `docker-compose.yml` runs Redis with `--appendonly yes --appendfsync everysec --maxmemory-policy noeviction`; delayed jobs reload. |
| **Redis unavailable during scheduling** | The transactional outbox hands jobs off later (startup + every 30 s). |
| **Elasticsearch down** | A DB trigger coalesces every insert/update/delete into `EmailSearchOutbox`; the worker retries with exponential backoff. |

Restart-safe means **not duplicated and not restarted from scratch**: the deterministic `jobId`, the atomic `scheduled → processing` claim, `ensureJob()` (idempotent re-creation of a missing job) and a deterministic `Message-ID` make repeated recovery passes harmless.

### 3. Idempotency (same email never sent twice)

| Layer | Mechanism |
|---|---|
| API | `Idempotency-Key` header (or `idempotencyKey` field), scoped per user, with a SHA-256 of the normalized request. Same key + same payload → original result replayed (`200`, `Idempotency-Replayed: true`); same key + different payload → `409 IDEMPOTENCY_KEY_REUSED`. Concurrent duplicates are serialized by a unique index. The frontend generates one key per distinct draft, so a double-click or retry is deduplicated. |
| Database | Unique `(ownerId, idempotencyKey)` on `Campaign` and `Email` (per-row key `<key>#<recipient>`), unique `Email.jobId`, unique `QueueOutbox.emailId`. |
| Queue | Deterministic job id `email_<emailId>` — adding it again is a no-op. |
| Worker | Atomic claim; duplicate jobs skip. |
| SMTP | Stable `Message-ID: <emailId@reachinbox.local>` and `X-ReachInbox-Email-Id` header. |

**Honest limit:** SMTP and PostgreSQL cannot share a transaction, so this is not a literal exactly-once claim. In the unavoidable window (server accepted the message, then the worker died before `sent` was written) the design chooses **at-most-once** and flags the row as `UNCERTAIN`.

**SMTP failure classification** — the question is *could the server have accepted the message?*

| Class | Examples | Result |
|---|---|---|
| `transient` | connection refused, DNS failure, timeout *before* the body was sent, any `4xx` | back to `scheduled`, exponential backoff, `failed` after `EMAIL_JOB_ATTEMPTS` |
| `permanent` | any `5xx`, bad credentials, rejected recipient | `failed` immediately |
| `uncertain` | timeout/reset *after* the body started flowing | `failed` (`UNCERTAIN: …`), never auto-retried |

---

## Rate limiting, delay and concurrency

### Worker concurrency (configurable)

`WORKER_CONCURRENCY` (default **5**) sets the BullMQ `Worker` concurrency per process. It is safe under parallelism because nothing relies on in-process state: claims are guarded SQL updates, and both limiters are atomic Redis Lua scripts.

### Minimum delay between sends — **2 seconds**

`MIN_DELAY_MS=2000` (default): **at most one send may start every 2 s across every worker, sender and campaign** — this models provider throttling.

It is implemented as a custom Redis/Lua "next allowed send time" key (`rl:send:next`) rather than BullMQ's `limiter`, because the job needs to be *deferred without consuming a retry attempt* and the clock must come from Redis. The script reads the **Redis server clock** and either **grants** (`now ≥ next` → `next = now + interval`) or **denies** returning the remaining wait while writing nothing. A denied job calls `moveToDelayed(wait + ≤100 ms jitter)` and competes again, so a cancelled or crashed job can never hold a slot that blocks others. `MIN_DELAY_MS=0` skips Redis entirely.

Separately, the compose form's **Delay between 2 emails** spaces one campaign's recipients: it is baked into each row's `scheduledAt` at creation. Both apply together.

### Emails per hour — global **and** per sender

| Limit | Env | Default | Scope |
|---|---|---|---|
| Global | `MAX_EMAILS_PER_HOUR` | 200 | all senders |
| Per sender | `MAX_EMAILS_PER_HOUR_PER_SENDER` | 100 | one sender address |
| Per campaign (optional) | compose form *Hourly Limit* → `hourlyLimit` | none | one scheduling request |

All limits come from env/config; nothing is hardcoded.

**Enforcement.** One atomic Lua script checks the **global**, **sender** and **campaign** counters for the current window and increments **all or none**, so a denial never consumes capacity of another scope. Counters are Redis keys `rl:g:<window>`, `rl:s:<sender>:<window>`, `rl:c:<campaign>:<window>` (2 h TTL) where `window = floor(redisTimeMs / 3,600,000)`, i.e. a **fixed UTC calendar hour** that resets at `HH:00:00Z`. Because counters live in Redis and time comes from the Redis clock, the limit holds across any number of workers or instances.

- **Effective limits:** `sender = min(sender override, per-sender cap, global)`; `campaign = min(requested, sender, global)`. A campaign can only add a *lower* cap, never raise capacity. The API also rejects an `hourlyLimit` above the sender cap.
- **Replay-safe:** each admission is remembered as `rl:res:<emailId>`, so a job that returns in the same window (e.g. throttled) does not double-count.
- **Refunds** only when SMTP was provably never attempted (e.g. cancelled before sending).

**When the limit is reached, nothing is dropped or failed.** The email returns to `scheduled`, its `scheduledAt` becomes `nextUTCHour + offset`, and its BullMQ job is moved there with `moveToDelayed` (PostgreSQL first, then BullMQ; a crash in between self-heals because the redelivered job sees the future `scheduledAt`). `offset` is 0–3.6 s (1 ms per second of original lateness), so earlier-scheduled emails wake slightly earlier — ordering is preserved **best-effort**, not guaranteed.

**Slack:** if the *sender* cap triggered the deferral, a Slack message is posted (see [Slack](#slack-notifications-required--live-oauth--real-message)).

**Trade-offs.** Fixed windows allow a burst at a window boundary (up to 2× the cap across an hour edge) — a sliding window would smooth this at the cost of more Redis work. The Lua scripts compute keys from the Redis clock, so they need **a single Redis node** (not Cluster).

---

## Behaviour under load (1000+ emails)

Scenario: **1000 emails due at the same moment** with defaults (`MIN_DELAY_MS=2000`, global 200/h, sender 100/h).

1. **Scheduling.** A request accepts up to `MAX_RECIPIENTS_PER_BATCH` (1000) unique recipients (further batches use further requests; bounded by the 2 MB JSON body limit). One transaction inserts all rows, then `addBulk` creates the delayed jobs. This is cheap — no SMTP happens at request time.
2. **When they fall due.** Each worker runs up to `WORKER_CONCURRENCY` jobs at once. Jobs beyond the hourly allowance are rejected at **step 2** (fast, no SMTP) and moved to the **next UTC hour** with the ordering offset.
3. **Admitted jobs** pass through the send-interval gate, so sends start **one per 2 s** regardless of concurrency or worker count (≈ 30/min; 100 emails ≈ 3.3 min).
4. **Next hours.** The deferred jobs wake at the next window and repeat. With a 100/h sender cap, 1000 emails from one sender drain over ~10 hours. **No email is lost, failed or duplicated**, and the queue state is visible in Bull Board throughout.
5. **A worker dying mid-flight** is covered by lock expiry, stalled-job redelivery and the stale-claim sweep.

This behaviour is exercised by the integration tests (e.g. limit 3 of 10 due together → exactly 3 sent and 7 durably deferred; 50 emails from one sender under heavy concurrency never exceed the hourly allowance; 24 competing callers never closer than the interval).

---

## Features implemented

### Backend

| Requirement | Status | Where |
|---|---|---|
| Accept scheduling requests via API | ✅ | `POST /api/emails/schedule` |
| Store in relational DB | ✅ PostgreSQL | `prisma/schema.prisma` |
| BullMQ delayed jobs, **no cron** | ✅ | `queues/email.queue.ts` |
| Multiple senders | ✅ per-owner `Sender` rows, per-sender caps | `scheduling.service.ts`, `hourly-limiter.service.ts` |
| Ethereal SMTP | ✅ | `services/smtp.service.ts` |
| Searchable via Elasticsearch | ✅ indexing + search + outbox + reindex | `services/email-search.service.ts` |
| Live BullMQ dashboard | ✅ Bull Board, read-only, admin-allow-listed | `middleware/bull-board.ts`, `/admin/queues` |
| Survives restarts, no duplicates | ✅ | outbox, deterministic job ids, guarded claims |
| Idempotency | ✅ | see [Idempotency](#3-idempotency-same-email-never-sent-twice) |
| Worker concurrency (configurable) | ✅ | `WORKER_CONCURRENCY` |
| Delay between sends | ✅ 2 s default | `MIN_DELAY_MS` |
| Emails-per-hour limit (global + per-sender), Redis-backed, safe across workers | ✅ | `hourly-limiter.service.ts` |
| Over-limit jobs delayed to next window, not dropped | ✅ | `workers/email.processor.ts` |
| Slack OAuth + live message on sender limit hit; graceful when not connected | ✅ | `services/slack.service.ts` |
| Defined behaviour for 1000+ emails | ✅ | [section above](#behaviour-under-load-1000-emails) |
| Google OAuth + Redis sessions + CSRF Origin check | ✅ | `services/auth.service.ts` |
| Extras | cancel scheduled email, star, status counts, health endpoint, graceful shutdown, secret redaction in logs | |

### Frontend

| Requirement | Status | Where |
|---|---|---|
| Real Google login | ✅ "Continue with Google" → backend OAuth | `components/auth/login-form.tsx` |
| Redirect to dashboard after login | ✅ → `/scheduled` | `auth.controller.ts` |
| User name, email, avatar + Logout | ✅ in the account card/menu of the sidebar | `components/mail/user-profile.tsx` |
| Scheduled / Sent tabs | ✅ sidebar tabs with live counts (plus a **Failed** tab) | `components/mail/sidebar.tsx` |
| "Compose New Email" | ✅ `Compose` button → `/compose` page | `components/compose/compose-form.tsx` |
| Subject + rich-text body | ✅ | `rich-text-editor.tsx` |
| Upload CSV/TXT of leads, show count detected | ✅ addresses parsed client-side, deduplicated, shown as chips with a toast (*"Added N recipients"*) | `recipient-input.tsx` |
| Start time, delay between emails, hourly limit | ✅ | `schedule-popover.tsx`, `compose-form.tsx` |
| Schedule → backend API | ✅ with an idempotency key | `lib/services/email-service.ts` |
| Scheduled list: email, subject, scheduled time, status | ✅ | `email-row.tsx`, `status-badge.tsx` |
| Sent list: email, subject, sent time, status (`sent`/`failed`) | ✅ — see note below | `mailbox-view.tsx`, `email-detail.tsx` |
| Loading states / empty states / error handling | ✅ skeleton rows, per-tab empty states, retry panel, toasts | `components/mail/states.tsx` |
| Clean structure, reusable components, typed API | ✅ | `components/ui`, `lib/types.ts`, `api-client.ts` |
| Extras | search, starred filter, pagination (25/page), 5 s auto-refresh, email detail page, cancel, Slack connect/disconnect | |

> **Note on layout.** Rows list *recipient · status badge (shows the scheduled time for scheduled mail) · subject — preview* rather than separate table columns. The **exact sent time** is shown on the email detail page; the Sent list row shows a *Sent* badge.

---

## API reference

All errors use one envelope: `{ "error": { "code", "message", "details?" } }`. Every email endpoint derives ownership from the verified session; client-supplied user ids are ignored. State-changing requests must carry the exact frontend `Origin`.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | `ok`, `degraded` (only Elasticsearch down) or `503 down` (PostgreSQL/Redis down) |
| GET | `/api/auth/google` · `/api/auth/google/callback` | Start / complete Google OAuth |
| GET | `/api/auth/me` · POST `/api/auth/logout` | Current user / destroy session |
| GET | `/api/slack/connect` · `/api/slack/callback` | Slack OAuth |
| GET · DELETE | `/api/slack/connection` | Connection status / disconnect |
| POST | `/api/emails/schedule` | Create a campaign (one email row + job per recipient) |
| GET | `/api/emails` | `page`, `pageSize` (≤ 100), `sort` (`scheduledAt\|createdAt\|sentAt\|subject`), `order`, `folder` (`all\|scheduled\|sent`), `status`, `search`, `starred`. `search` uses Elasticsearch with PostgreSQL fallback. Max 10,000-result window. |
| GET | `/api/emails/search` | Alias of the list endpoint |
| GET | `/api/emails/counts` | `scheduled, processing, sent, failed, cancelled, pending, total` |
| GET | `/api/emails/:id` | Owned email only, else 404 |
| POST | `/api/emails/:id/cancel` | Atomic `scheduled → cancelled`; removes the BullMQ job when possible (the worker re-checks the DB regardless) |
| PATCH | `/api/emails/:id/star` | `{ "starred": true\|false }` |
| GET | `/admin/queues` | **Bull Board** (session + admin-email allow-list) |

### `POST /api/emails/schedule`

```bash
# Sign in via the frontend first, then copy the `reachinbox.sid` cookie from the browser dev tools.
curl -i -X POST http://localhost:4000/api/emails/schedule \
  -H 'Content-Type: application/json' \
  -H 'Origin: http://localhost:3000' \
  -H 'Cookie: reachinbox.sid=<session-cookie-value>' \
  -H 'Idempotency-Key: campaign-2026-11-01-001' \
  -d '{
    "from": "hello@domain.io",
    "to": ["a@example.com", {"email": "b@example.com", "name": "B"}],
    "subject": "Hello",
    "bodyHtml": "<p>Hi there</p>",
    "scheduledAt": "2026-11-01T09:00:00Z",
    "delayBetweenSeconds": 30,
    "hourlyLimit": 50
  }'
```

| Field | Rules |
|---|---|
| `from` | Required valid address; registered as the owner's `Sender` on first use |
| `to` | Required array of strings or `{email, name?}`; trimmed, lower-cased, duplicates dropped (first wins); unique count ≤ `MAX_RECIPIENTS_PER_BATCH` |
| `subject` | 1–200 chars, no control characters/line breaks |
| `bodyHtml` | Required; sanitized server-side (allow-list); plain-text alternative derived |
| `scheduledAt` | Optional ISO-8601 **with UTC offset**. Omitted = now; ≤ 60 s in the past is clamped to now, older is rejected; max 1 year ahead |
| `delayBetweenSeconds` | Optional int 0–3600; recipient *i* is due at `scheduledAt + i × delay` |
| `hourlyLimit` | Optional int `1…MAX_EMAILS_PER_HOUR_PER_SENDER` (per-campaign cap) |
| `attachments` | Not supported — a non-empty array is rejected, not silently dropped |
| `Idempotency-Key` header / `idempotencyKey` | Optional, 8–128 chars `[A-Za-z0-9._:-]` |

Responses: **201** created / **200** replay (`Idempotency-Replayed` header) with `campaign`, `recipients`, `emails[]`; **400 `VALIDATION_ERROR`** listing every problem as `details[{path,message}]` (nothing written); **409 `IDEMPOTENCY_KEY_REUSED`**; **401** unauthenticated; **503 `QUEUE_UNAVAILABLE`** (`persisted: true` — safe to retry).

---

## Demo video

> 📹 **Video link:** _add your link here (max 5 minutes)_

Suggested recording flow, mapped to the requirements:

1. **Create scheduled emails.** Sign in with Google → Compose → upload a CSV (show the detected count) → set start time ≈ 2 minutes ahead, delay `10`, → **Schedule**. Show the **Scheduled** tab and `/admin/queues` (delayed jobs).
2. **Sent emails.** Wait for delivery → **Sent** tab → open one email; open its Ethereal message (`previewUrl` / Ethereal inbox).
3. **Restart scenario.** Schedule more emails ≈ 2 min ahead → stop the API and worker (`Ctrl+C`) → confirm the jobs are still delayed in Bull Board / the DB rows are still `scheduled` → start both again → emails still send at the correct time, with no duplicates.
4. **Rate limiting / delay under load (bonus).** Set in `backend/.env`:
   ```dotenv
   MIN_DELAY_MS=2000
   MAX_EMAILS_PER_HOUR_PER_SENDER=3
   ```
   Restart API + worker, connect Slack, schedule **10** recipients for "now". Show: sends spaced ≥ 2 s apart, exactly 3 sent, the other 7 delayed to the next hour in Bull Board (not failed), and the **live Slack message** in the channel.
5. **Search.** Type a subject or recipient in the search box (served by Elasticsearch).

## Tests

```bash
cd backend
pnpm typecheck && pnpm build
pnpm test                                    # unit tests; DB/Redis suites are skipped

DATABASE_URL=postgresql://reachinbox:reachinbox@localhost:5432/reachinbox \
REDIS_URL=redis://localhost:6379 pnpm test   # full suite incl. integration
```

Integration tests run against **real PostgreSQL, real Redis/BullMQ and a local SMTP *protocol* server** (`smtp-server`) — no external network. They are skipped (and reported as skipped) when `DATABASE_URL` / `REDIS_URL` are unset. Apply migrations first (`pnpm prisma:deploy`) when running against Compose.

| File | What it proves |
|---|---|
| `scheduling.integration.test.ts`, `scheduling.validation.test.ts` | Validation, idempotent replay, key reuse → 409, 50 simultaneous identical requests, transactional all-or-nothing |
| `email-processor.integration.test.ts` | Every state transition: claim, duplicate job, skip, transient/permanent/uncertain, deferral ≠ attempt, stale reclaim, DB error after SMTP accepted |
| `delivery.integration.test.ts` | Full API → BullMQ → worker → SMTP; interval across 2 workers; 3-of-10 hourly limit; 50 emails under concurrency stay within the allowance; backoff; API/worker restart; graceful shutdown |
| `hourly-limiter.integration.test.ts` | Exact cap under concurrency, replay, scopes, UTC boundary, refund |
| `send-throttle.test.ts` | Grant/deny, no writes on denial, 24 competing callers never closer than the interval |
| `smtp.service.test.ts` | Exact message content over SMTP; error classification; no secrets in errors |
| `slack.test.ts` | OAuth state ownership, encrypted token, retries, revoked token, limit-hit notification, de-duplication |
| `email-search.test.ts` | Mapping, idempotent upsert/delete, outbox retries, owner filters, reindex |
| `auth.test.ts`, `bull-board.test.ts`, `email-api.test.ts`, `config.test.ts`, `health.test.ts`, `schema.integration.test.ts`, `queue-*.test.ts`, `utils.test.ts` | OAuth/PKCE/session checks, admin gate, owner scoping, config rules, health states, schema, queue hand-off/recovery |

Google and Slack HTTP calls are mocked in tests, so no credentials are needed to run them; the live flows must be verified with real credentials. The frontend has no test runner — validate with `pnpm exec tsc --noEmit && pnpm build`.

---

## Deployment

See [RAILWAY.md](RAILWAY.md): one Railway project with PostgreSQL, Redis, a **backend** service (root `backend`, migrations + API + worker in one container) and a **frontend** service (root `frontend`, with `NEXT_PUBLIC_API_BASE_URL` set *before* the first build). Set `GOOGLE_CALLBACK_URL=https://<backend-domain>/api/auth/google/callback` and register that exact URI in Google Cloud.

---

## Assumptions, shortcuts and trade-offs

**Assumptions**
- One Ethereal SMTP account serves **all** senders; the `From` address is applied as-is (Ethereal accepts any `From` once authenticated; a real provider would require verified senders).
- The compose UI sends from the signed-in user's Google email, so a UI user has one sender. The API supports many sender addresses per user, each with its own hourly counter.
- Hourly windows are **UTC calendar hours**.
- One scheduling request = one campaign; each recipient becomes its own email row, job and (eventually) Sent/Failed entry.

**Shortcuts / known limitations**
- **No attachments.** The backend rejects them explicitly and the UI does not offer fake uploads.
- **`from` is unrestricted**, so per-sender caps can be sidestepped by inventing sender addresses (the global cap still holds). A real deployment would tie senders to verified SMTP identities and cap senders per user.
- **Slack fires only on the per-sender cap**, not on the global or per-campaign cap.
- **Uncertain deliveries need a human.** They are marked `failed` with `UNCERTAIN:` and the Message-ID; there is no retry endpoint yet.
- **Redis total data loss.** The outbox covers a failed *hand-off* and AOF covers restarts, but if Redis loses already-handed-off future jobs (e.g. `FLUSHALL`), they are not re-created automatically. `EmailQueue.ensureJob()` is the building block for a full re-sync.
- **Single Redis node only** (Lua scripts derive keys from the Redis clock; not Cluster-safe).
- **Fixed-window** hourly limits (burst possible across a window boundary).
- **Ordering is best-effort** among emails due at the same instant; campaign `delayBetweenSeconds` staggering is deterministic.
- **Spacing is measured at send start**; arrival at the SMTP server differs by the handshake time.
- **Cancel** works only before a scheduled email is claimed for processing; afterwards the worker simply skips a cancelled row.
- Recipient addresses are lower-cased and must be ASCII (internationalized addresses are rejected); the 2 MB JSON limit bounds practical batch size.
- Bull Board is **read-only** and only mounted when `BULL_BOARD_ADMIN_EMAILS` is set.
- The compose file is for **local development only** (unauthenticated PostgreSQL/Redis, Elasticsearch security off).
- Frontend: `next.config.mjs` sets `typescript.ignoreBuildErrors: true`; `NEXT_PUBLIC_DEMO_MODE=true` bypasses the session check (keep it unset). `.env.example` contains sample secret values — **always generate your own**.
