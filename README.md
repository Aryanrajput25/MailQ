# ReachInbox Email Scheduler

> **Deploying?** See [RAILWAY.md](RAILWAY.md) for the one-go Railway setup.

Reliable email scheduling: Next.js dashboard + Express/BullMQ backend (PostgreSQL, Redis, Elasticsearch).
**Status: Checkpoint 11 - final integration checks completed where services were available.** The frontend is connected to authenticated email APIs, with Google OAuth sessions, BullMQ delivery and recovery, Slack alerts, Elasticsearch search, and secured Bull Board.

```
reachinbox-assignment/
├── frontend/            Next.js dashboard (Google sign-in; session-backed mailboxes and scheduling)
├── backend/
│   ├── src/{config,middleware,routes,controllers,services,repositories,
│   │        schemas,queues,workers,integrations,utils}/
│   │   ├── app.ts       Express app factory (helmet, credentialed CORS, JSON errors)
│   │   ├── server.ts    API process (graceful shutdown)
│   │   └── worker.ts    Separate BullMQ email worker
│   ├── prisma/          schema.prisma + migrations/
│   └── tests/
├── docker-compose.yml   PostgreSQL 16, Redis 7 (AOF), Elasticsearch 8.15
└── FRONTEND_INSPECTION.md
```

## Prerequisites
Node.js >= 20, pnpm (frontend), npm (backend), Docker with ~1 GB free RAM for Elasticsearch.
On Linux, Elasticsearch may need `sudo sysctl -w vm.max_map_count=262144`.
The included Compose file is for local development only: PostgreSQL/Redis are unauthenticated on the host-published ports and Elasticsearch security is disabled.

## Run it
```bash
# 1. infrastructure (from repo root)
docker compose up -d

# 2. configure backend (first run only; never commit .env)
cd backend
cp .env.local .env
# Set independent values for SESSION_SECRET and TOKEN_ENCRYPTION_KEY:
# openssl rand -hex 32 (run twice); configure Google OAuth below.
# For local DB/Redis, use the connection values corresponding to docker-compose.yml.
npm install                   # also runs `prisma generate`
npx prisma migrate deploy     # applies prisma/migrations

# 3. backend API (new terminal, from backend/)
npm run dev                   # http://localhost:4000/api/health

# 4. worker (another terminal, from backend/) - queue timing/limits are enforced through Redis
cd backend && npm run worker

# 5. frontend (another terminal)
cd frontend
cp .env.local .env.local   # NEXT_PUBLIC_API_BASE_URL=http://localhost:4000
pnpm install && pnpm dev
```
Production-style run: apply migrations before deploying, then `cd backend && npm run build && npm start` and
`npm run start:worker` as separate services; run `cd frontend && pnpm build && pnpm start`. Configure HTTPS,
trusted secret storage, OAuth redirect URIs, an explicit frontend origin, secured PostgreSQL/Redis/Elasticsearch,
and `BULL_BOARD_ADMIN_EMAILS`. Do not deploy the development Compose credentials/settings to production.

## Configuration
All variables are in `backend/.env.example` and validated at startup with Zod; startup fails with
a list of every problem. Optional groups (Google, Slack, Ethereal) must be set completely or not at all.
In `NODE_ENV=production`, Google OAuth, Ethereal SMTP and at least one Bull Board administrator email are mandatory.
`MAX_EMAILS_PER_HOUR_PER_SENDER` may not exceed `MAX_EMAILS_PER_HOUR`.
For Google sign-in, create an OAuth 2.0 Web client in Google Cloud Console. Add
`http://localhost:4000/api/auth/google/callback` as an authorized redirect URI, then set
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and the identical `GOOGLE_CALLBACK_URL` in `backend/.env`.
Set `NEXT_PUBLIC_API_BASE_URL=http://localhost:4000` in `frontend/.env.local` (from `frontend/.env.example`).
The Google OAuth Web client must use `http://localhost:4000/api/auth/google/callback` as its redirect URI;
the backend redirects successful sessions to the configured `FRONTEND_URL` (`http://localhost:3000` locally).
Login initiation returns
`503 AUTH_UNAVAILABLE` until all three backend OAuth variables are configured; there is no development
or fake login fallback. Generate `SESSION_SECRET` with `openssl rand -hex 32`. Sessions live in Redis for
seven days; the cookie is HTTP-only, signed, SameSite=Lax, and Secure in production. Production requires
HTTPS and a correctly configured TLS proxy.
For local frontend/backend development, use `localhost` consistently for both origins (do not mix `localhost`
and `127.0.0.1`). The frontend sends fetch credentials for the HTTP-only session cookie; Express credentialed
CORS and the exact `FRONTEND_URL` Origin check must match the frontend origin. The cookie is never stored in
browser storage. In production, serve both applications over HTTPS and configure `FRONTEND_URL` to the exact
public frontend origin.
For Slack notifications, create a Slack app with OAuth redirect URI
`http://localhost:4000/api/slack/callback` and the bot OAuth scopes `chat:write` and `incoming-webhook`.
Set `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and the exact `SLACK_REDIRECT_URI` in `backend/.env`;
the Slack app's OAuth flow prompts the user to select the destination channel. The bot token is stored
AES-256-GCM encrypted using `TOKEN_ENCRYPTION_KEY`; only a successful install for the authenticated user
is associated with that user's workspace/channel.
Elasticsearch is optional for scheduling and delivery. Set `ELASTICSEARCH_URL` (defaults to
`http://localhost:9200`) and, for a secured cluster, `ELASTICSEARCH_API_KEY`. The included Docker Compose
configuration runs a local development-only unsecured Elasticsearch 8.15 service.
| Variable | Default | Meaning |
|---|---|---|
| `WORKER_CONCURRENCY` | 5 | jobs one worker process runs in parallel |
| `MIN_DELAY_MS` | 2000 | **global provider throttle**: minimum gap between any two send starts, across all workers (0 disables) |
| `MAX_EMAILS_PER_HOUR` | 200 | global cap per UTC clock hour |
| `MAX_EMAILS_PER_HOUR_PER_SENDER` | 100 | per-sender cap per UTC clock hour (must be <= the global cap) |
| `EMAIL_JOB_ATTEMPTS` / `EMAIL_JOB_BACKOFF_MS` | 3 / 5000 | bounded exponential retry: waits `backoff * 2^(n-1)` |
| `STALE_PROCESSING_MS` | 300000 | a `processing` row older than this is treated as abandoned by a crashed worker |
| `SMTP_TIMEOUT_MS` | 20000 | SMTP connection / greeting / socket timeout |
| `ETHEREAL_HOST/PORT/USER/PASS` | empty | SMTP credentials (all four or none). Required in production; empty in development = auto-create an account |
| `SLACK_CLIENT_ID/CLIENT_SECRET/REDIRECT_URI` | empty | Optional Slack app OAuth v2 credentials; all three required to enable connect and notifications |
| `TOKEN_ENCRYPTION_KEY` | required | AES-256-GCM key material for stored Slack bot tokens; generate with `openssl rand -hex 32` |
| `ELASTICSEARCH_URL` | `http://localhost:9200` | Elasticsearch endpoint |
| `ELASTICSEARCH_API_KEY` | empty | Optional API key sent as `Authorization: ApiKey ...` |
| `BULL_BOARD_ADMIN_EMAILS` | empty | Comma-separated, explicitly authorized Google account emails; empty disables the queue dashboard outside production |

### Bull Board queue monitor
Bull Board is mounted at `http://localhost:4000/admin/queues` and registers the existing `email-delivery`
BullMQ `Queue` instance used by the API for scheduling. Delayed email jobs appear in the same queue that the
worker consumes; no second queue or monitoring Redis connection is created. The dashboard is read-only and
shows supported states, job data, and failure reasons.

Access always requires a valid Redis-backed ReachInbox session and an email address listed in
`BULL_BOARD_ADMIN_EMAILS`. Set this to one or more comma-separated, verified Google sign-in emails in
`backend/.env`; all other authenticated users receive 403, and the dashboard is not mounted when the list
is empty. Production startup fails if the administrator list is missing or malformed. Configure the
allowlist through trusted deployment environment settings, use HTTPS in production, and do not rely on
network privacy as authorization. Sessions retain the existing HTTP-only, signed, SameSite=Lax and
production Secure cookie settings. The board is deliberately read-only to prevent accidental queue
mutation or delivery changes through its UI.

## API
| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | `200 ok`, `200 degraded` (only Elasticsearch down), `503 down` (PostgreSQL or Redis down) |
| GET | `/api/auth/google` | Starts Google OAuth/OIDC with one-time Redis state, nonce and PKCE. |
| GET | `/api/auth/google/callback` | Validates state and Google identity, regenerates the server-side session, then redirects to the frontend. |
| GET | `/api/auth/me` | Returns the authenticated session user. |
| POST | `/api/auth/logout` | Destroys the Redis session and clears its cookie. |
| GET | `/api/slack/connect` | Starts Slack OAuth for the signed-in user. |
| GET | `/api/slack/callback` | Validates one-time user-bound OAuth state, exchanges the code and securely stores the workspace/channel token. |
| GET | `/api/slack/connection` | Returns only the current user's Slack connection status and workspace/channel names. |
| DELETE | `/api/slack/connection` | Disconnects the current user's Slack workspace. |
| POST | `/api/emails/schedule` | Preserves transactional schedule/outbox/idempotent BullMQ behavior. |
| GET | `/api/emails` | Owner-scoped list with `page`, `pageSize` (max 100; max 10,000-result window), `sort`, `order`, `folder`, `status`, `search`, and `starred` filters. Returns `items` and `pagination`. |
| GET | `/api/emails/search` | Same owner-scoped search/filter/pagination parameters as the list endpoint; `search` uses Elasticsearch and falls back to PostgreSQL when Elasticsearch is down. |
| GET | `/admin/queues` | Session- and admin-email-protected, read-only Bull Board monitor (mounted outside the public email API). |
| GET | `/api/emails/counts` | Owner-scoped status counts (`scheduled`, `processing`, `sent`, `failed`, `cancelled`, `pending`, `total`). |
| GET | `/api/emails/:id` | Retrieves an email only when owned by the authenticated user; otherwise 404. |
| POST | `/api/emails/:id/cancel` | Atomically changes only `scheduled` rows to `cancelled`; removes a non-active BullMQ job where possible. A queued/active job still checks the authoritative database status before delivery. |
| PATCH | `/api/emails/:id/star` | Sets `{ "starred": true|false }` for an owned email. |

All API responses use the shared `{ "error": { "code", "message", ... } }` error envelope. Email list/detail/count/cancel/star
operations derive ownership from the verified session, include `ownerId` in database predicates, and ignore any client-supplied user IDs.

### Frontend integration
The Next.js dashboard uses the typed `frontend/lib/services/api-client.ts` client and
`NEXT_PUBLIC_API_BASE_URL` from `frontend/.env.local`. It includes cookies on API requests and surfaces backend
validation and authorization errors rather than substituting sample data. Google sign-in redirects through the
backend OAuth endpoints; protected mail, compose, and detail pages verify `/api/auth/me`, and session expiry
returns the user to sign-in. Mailboxes, search, pagination, counts, star state, detail views, scheduling,
cancellation, and Slack connection controls use the existing API endpoints.

Submitting without a selected future date schedules the email for immediate queue processing; the UI reports it
as queued, not sent. Sent status is shown only after the worker updates the authoritative database. Attachments
are not supported by the backend yet, so no fake local attachment upload is offered. The recipient-list CSV/TXT
upload remains client-side input parsing and submits the validated addresses to the scheduling endpoint.

### Elasticsearch email index
`reachinbox-emails-v1` is a versioned projection, not a source of truth. It indexes only searchable email fields
(email ID/owner, status, subject, plain-text body, sender/recipient names and addresses, scheduled/sent/created
times and starred state). It excludes HTML, SMTP credentials, tokens, session state and provider configuration.
The strict explicit mapping is created idempotently when search or index reconciliation first needs it.

The `Email_search_sync` PostgreSQL trigger writes/coalesces an `EmailSearchOutbox` event in the same transaction
as every email insert, update, or delete. The existing worker retries this outbox at startup and every 30 seconds
with bounded exponential backoff; an Elasticsearch outage therefore does not block scheduling or SMTP delivery.
Search includes the authenticated owner filter in Elasticsearch and then hydrates results from PostgreSQL with
an additional `ownerId` predicate. If Elasticsearch is unavailable, the endpoint performs an owner-scoped
PostgreSQL text-search fallback. Status and folders, paging, starred filter, and deterministic sorting apply in
both search and list paths.

Start local dependencies with `docker compose up -d`; apply the new trigger/outbox migration with
`cd backend && npx prisma migrate deploy`. To rebuild indexed documents from current PostgreSQL data after
index loss or mapping changes, run `cd backend && npm run search:reindex` while Elasticsearch is available.
Deleted records are removed through the same transactional trigger/outbox path.

### Authentication and CSRF
The frontend's **Continue with Google** button navigates to `/api/auth/google`. OAuth uses one-use Redis-backed state
bound to a short-lived HTTP-only browser cookie, an OIDC nonce, PKCE S256, the authorization-code exchange, and Google token-info verification of issuer, audience,
expiration, nonce, subject and verified email. The backend never accepts `X-Dev-User-Email` or a client user ID as identity.
The server-side session is stored in Redis under a fresh, random session ID after login; its signed HTTP-only cookie is
regenerated at every successful login. `GET /api/auth/me` verifies that session; `POST /api/auth/logout` removes it.
Credentialed CORS allows only `FRONTEND_URL`, and every state-changing API request requires its exact Origin.
If Google credentials are unavailable, mocked tests cover the flow but live Google authentication is not verified.

### Slack hourly-limit notifications
The authenticated account menu's **Connect Slack** action starts the Slack OAuth v2 flow. The protected
`GET /api/slack/connection` and `DELETE /api/slack/connection` endpoints inspect and remove only that user's
connection. A worker sends a real `chat.postMessage` when the existing hourly limiter defers an email due to
a sender hourly cap. Global and campaign cap events do not generate Slack alerts. When Slack is not configured or the user has no active connection, this
notification is skipped without changing email delivery or deferral.

Notifications are deduplicated per owner + sender + UTC hour, so retried BullMQ jobs do not intentionally
repeat the alert. The Slack `client_msg_id` is deterministic for that event. Transient network/5xx and
`429` responses are retried up to three times (honoring `Retry-After` up to 30 seconds); revoked credentials
are marked and require reconnecting. Exhausted notification failures are logged, while the email remains
durably deferred to its next BullMQ time.

### `POST /api/emails/schedule`
Field names match the frontend's `EmailDraft`.
```bash
# Sign in through the frontend first, then supply the reachinbox.sid cookie from the browser:
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
| `from` | required valid address; registered as the owner's `Sender` on first use |
| `to` | required array of strings or `{email, name?}`; trimmed + lowercased, duplicates dropped (first wins, order kept); unique count <= `MAX_RECIPIENTS_PER_BATCH` |
| `subject` | 1-200 chars, no control characters / line breaks |
| `bodyHtml` | required, sanitized server-side (allowlist mirrors the editor); plain-text alternative is derived |
| `scheduledAt` | optional ISO-8601 **with UTC offset**; omitted = now; up to 60 s in the past is clamped to now, older is rejected; max one year ahead |
| `delayBetweenSeconds` | optional int 0-3600. Campaign pacing: recipient *i* is due at `scheduledAt + i x delay` (stored per row) |
| `hourlyLimit` | optional int 1..`MAX_EMAILS_PER_HOUR_PER_SENDER` (stored on the campaign; enforced when the worker lands) |
| `attachments` | not supported yet - a non-empty array is rejected, not silently dropped |
| `Idempotency-Key` header or `idempotencyKey` body field | optional, 8-128 chars `[A-Za-z0-9._:-]` |

* **201** created / **200** replay (`Idempotency-Replayed: true|false` header). Body: `campaign`, `recipients`
  (`accepted`, plus `submitted`/`duplicatesRemoved` on creation), and `emails[]` (`id`, `to`, `scheduledAt`, `status`, `jobId`).
* **400 `VALIDATION_ERROR`** lists *every* problem as `details: [{path, message}]` (e.g. `to.3`), so a client can fix them in one pass. Nothing is written.
* **409 `IDEMPOTENCY_KEY_REUSED`**: same key, different payload. **401** unauthenticated.

**Idempotency.** Scoped per user: `Campaign(ownerId, idempotencyKey)` is unique and stores a SHA-256 of the normalized
request. Same key + same payload returns the original result (no new rows); concurrent duplicates are serialized by the unique
index and the loser replays the winner. Without a key the request is not deduplicated (a random key is generated).
Each email row's key is `<key>#<recipient>`. `scheduledAt` is hashed as sent, so retrying an immediate send still matches.

**Transaction.** Sender upsert, campaign and all email rows (inserted in chunks of 1000) commit together or not at all.
Each email gets a time-sortable id (batch order recoverable from `ORDER BY id`) and a deterministic `jobId = email_<id>`.
**Queue handoff.** After the PostgreSQL transaction commits, the API adds a delayed `email-delivery` BullMQ job per row. The
job id is the stored deterministic `email_<email-id>`, so a replay or later reconciliation can add it again without duplicate work.
The delay is `max(0, scheduledAt - now)`. A successful response means both persistence and queue insertion succeeded.
If Redis insertion fails, the endpoint returns **503 `QUEUE_UNAVAILABLE`** with `{ persisted: true }`; no misleading success is returned.
Retrying the same idempotency key safely retries the idempotent queue handoff.

### Durable queue recovery

Checkpoint 4 replaces that recovery window with a transactional `QueueOutbox`: every `Email` row and its outbox record are
committed in the same PostgreSQL transaction. The API immediately attempts to create deterministic BullMQ jobs and marks the
outbox events delivered only after Redis accepts them. If Redis is unavailable it returns `503 QUEUE_UNAVAILABLE` with
`persisted: true, recoverable: true`; no scheduled email is lost. The worker drains pending outbox records on startup and
every 30 seconds. This is recovery only—BullMQ delayed jobs remain the sole scheduling mechanism. Repeated handoffs are safe
because job IDs are deterministic.

### Delivery: Nodemailer + Ethereal

**Setup (pick one).**
1. *Auto-create (development only, needs internet).* Leave `ETHEREAL_*` empty. On first send the worker calls
   `nodemailer.createTestAccount()` and logs the SMTP host/port (never the password). It is refused in production.
2. *Fixed account.* Create one at <https://ethereal.email/create> and put the four values in `backend/.env`
   (`ETHEREAL_HOST=smtp.ethereal.email`, `ETHEREAL_PORT=587`, `ETHEREAL_USER`, `ETHEREAL_PASS`). Port 465 uses implicit TLS.

On startup the worker runs `verify()` (connect + authenticate). In production a failure stops the worker; in development it only warns.

**Opening a delivered message.** Ethereal never delivers to real inboxes - it captures mail. Log in at
<https://ethereal.email/login> with the account's credentials and open *Messages*, or open the `Email.previewUrl` stored for the row:
```bash
psql "$DATABASE_URL" -c "select \"recipientEmail\", status, \"smtpMessageId\", \"previewUrl\" from \"Email\" order by \"createdAt\" desc limit 5"
```
The authenticated list endpoint is `GET /api/emails?folder=sent`.

**What is sent.** `From` = the sender row (`name <address>`), `To`, `Subject`, the sanitized HTML body and the derived plain-text
alternative, a deterministic `Message-ID: <emailId@reachinbox.local>`, and an `X-ReachInbox-Email-Id` header. The UI's sender
address is used as-is; Ethereal accepts any `From` once authenticated, a real provider generally requires a verified sender.

**Failure handling** (`classifySmtpError`). The question that matters is "could the server have accepted the message?":

| Outcome | Examples | Result |
|---|---|---|
| `transient` - provably **not** accepted | connection refused, DNS failure, timeout/reset *before* the body was sent, any `4xx` reply | back to `scheduled`, retried with exponential backoff; `failed` after `EMAIL_JOB_ATTEMPTS` |
| `permanent` | any `5xx`, bad credentials, rejected recipient | `failed` immediately, never retried |
| `uncertain` | timeout / reset / dropped connection **after** the body started flowing | `failed` with `UNCERTAIN: ...` and the Message-ID; **never retried automatically** |

Nodemailer reports `command: "CONN"` even for failures after the body was sent, so the error cannot be trusted to tell the phase.
The service tracks it directly (a Nodemailer `stream` hook records when the body starts flowing); if that hook were ever missing,
network errors default to `uncertain`. Passwords/users are redacted from error messages and are never logged.

**`sent` is written only after the server accepted the message.** If PostgreSQL fails *after* SMTP accepted, the row is **not** marked
failed or retried: it stays `processing` with `smtpAttemptedAt` set and the job fails with an explicit message; recovery later flags it
`UNCERTAIN` rather than resending.

**No exactly-once claim.** SMTP and PostgreSQL cannot share a transaction. The unavoidable window: the server accepts the message and the
worker dies (or the DB write fails) before `sent` is recorded. The design chooses *at-most-once* there - the email is flagged
`UNCERTAIN` and not resent - and uses the stable Message-ID so an operator can check the mailbox. A crash *before* SMTP started is
retried safely (`smtpAttemptedAt` is NULL).

### Worker pipeline and state machine
`scheduled -> processing -> sent | failed`, with `processing -> scheduled` for deferrals and transient retries. Every transition is a
single guarded `UPDATE ... WHERE status = ...`, so only one worker can win any step.

1. **Claim** (`scheduled -> processing`). A duplicate job loses here and never touches Redis or SMTP. Not yet due (job fired early or the
   row was deferred)? It re-delays itself to `scheduledAt`. Cancelled/sent/failed/missing rows are skipped.
2. **Hourly capacity** (atomic Lua). Denied => the row returns to `scheduled` with `scheduledAt` moved to the next UTC hour, then the
   BullMQ job is moved there too (PostgreSQL first, then BullMQ; a crash in between self-heals because the redelivered job sees the
   future `scheduledAt`).
3. **Global interval slot** (atomic Lua). Denied => the claim is released and the job is delayed by the exact remaining wait.
4. **Record the attempt** (`attemptCount++`, `smtpAttemptedAt`). Deferrals never count as attempts, and BullMQ's retry budget is untouched
   (`moveToDelayed` + `DelayedError`, not a failure).
5. **Send**, then record `sent`/`sentAt`/`smtpMessageId`/`previewUrl`.

**Crashes.** BullMQ redelivers a job whose worker lost its lock (`lockDuration` 30 s, `maxStalledCount` 1). A redelivered or stale
(`STALE_PROCESSING_MS`) `processing` row is reclaimed **only if `smtpAttemptedAt` is NULL**; otherwise it is flagged `UNCERTAIN`.
Startup and the 30-second recovery pass also run `recoverStaleProcessing()`. That timer only repairs lost queue handoffs and crashed
claims - it never decides when mail is sent; BullMQ delayed jobs own that. `ensureJob()` makes recovery idempotent, including replacing
a retained completed/failed job (BullMQ silently ignores `add` for an existing job id).

### Global send interval (`MIN_DELAY_MS`) vs campaign delay
*Campaign delay* (`delayBetweenSeconds`) spaces one campaign's recipients: it is baked into each row's `scheduledAt` at creation.
*Global throttle* (`MIN_DELAY_MS`) models the provider's limit across **every** campaign, sender, worker and process. Both apply.

Algorithm (`send-throttle.service.ts`): one Redis key holds the earliest instant the next send may start; a Lua script reads **Redis's
clock** (never a worker's) and either *grants* (`now >= next`, sets `next = now + interval`) or *denies* returning the remaining wait and
**writing nothing**. Consequences: a deferred, cancelled or crashed job can never hold a slot that blocks others; there is no stale state
(the key expires by itself); slots are never "released" because that would allow two sends closer than the interval. Deferred jobs wake
after `wait + <=100 ms jitter` and compete again. `MIN_DELAY_MS=0` skips Redis entirely. Requires Redis >= 5, single node.

### Hourly limits
Window = **UTC calendar hour** (`floor(redisTimeMs / 3_600_000)`; resets at HH:00:00Z). One atomic Lua script checks the **global**,
**per-sender** and **per-campaign** counters and increments all of them or none (a denial never consumes capacity of another scope).

* **Effective limits** (`effectiveLimits`): `sender = min(sender override, MAX_..._PER_SENDER, global)`;
  `campaign = min(requested hourlyLimit, sender, global)`. A campaign can only add a *lower* cap; it can never raise capacity, even if
  the configured caps are lowered after the campaign was created. The API additionally rejects `hourlyLimit` above the sender cap.
* **Replay-safe**: each admission is stored as `res:<emailId>`. A job that comes back (e.g. throttled) in the same window does not
  double count. A reservation from an *earlier* window that never sent is released before re-reserving.
* **Refunds** happen only when SMTP was provably never attempted (the email was cancelled before sending). After an attempt, capacity
  stays consumed because a message may have been accepted.
* **Deferral**: never dropped or failed. `scheduledAt = nextUTCHour + offset`, where `offset` (0-3.6 s, 1 ms per second of original
  lateness) keeps earlier-scheduled emails slightly earlier. Ordering among emails due at the same instant is best-effort.
* Example: limit 3, ten emails due together => exactly 3 are admitted, 7 are durably re-delayed (verified with two workers).

## Data model
`User`, `Sender`, `Campaign`, `Email`, `SlackConnection` (see `backend/prisma/schema.prisma`).
One scheduling request = one `Campaign` (carries the idempotency key, delay and requested hourly limit)
= N `Email` rows, one per recipient. Unique constraints: `(ownerId, idempotencyKey)` on both Campaign and Email,
`Email.jobId`, one `SlackConnection` per user. `Email.status`: scheduled, processing, sent, failed, cancelled.
PostgreSQL is authoritative; Redis and Elasticsearch are derived state.

## Tests
```bash
cd backend
npm run typecheck && npm run build
npm test
DATABASE_URL=postgresql://reachinbox:reachinbox@localhost:5432/reachinbox \
REDIS_URL=redis://localhost:6379 npm test
```
Integration tests are **skipped** (and reported as skipped) when `DATABASE_URL` / `REDIS_URL` are unset - set both for the full suite.
They use real PostgreSQL, real Redis/BullMQ, and a real local SMTP *protocol* server (`smtp-server`), so no external network is needed.
For the frontend, run `cd frontend && pnpm exec tsc --noEmit && pnpm build`. There is currently no frontend lint or unit-test script configured.
In the Checkpoint 11 verification environment, the backend suite reported 132 passed and 72 skipped (4 integration test files);
the Prisma schema validated, but live migrations could not run because PostgreSQL was unreachable. Docker daemon unavailability
also prevented starting PostgreSQL, Redis, Elasticsearch, the API, and worker for live end-to-end checks.

| File | What it proves |
|---|---|
| `auth.test.ts` | OAuth state/PKCE with mocked Google responses, identity checks, Redis sessions, unauthenticated access and logout |
| `email-api.test.ts` | owner scoping, filtering, pagination, counts, invalid/cross-user IDs and scheduled cancellation |
| `email-search.test.ts` | index mapping, idempotent upsert/delete, status updates, durable retries, owner filters, sorting/pagination, and reindex batches |
| `slack.test.ts` | Slack OAuth/state ownership, encrypted token storage, protected status, notification retries, rate limits, revoked tokens, worker limit-hit event and duplicate-job dedupe |
| `smtp.service.test.ts` | exact From/To/Subject/HTML/text over the SMTP protocol; 4xx/5xx/auth/refused/greeting-timeout/post-body-timeout/dropped-connection classification; no password in errors; dev auto-create only when allowed |
| `send-throttle.test.ts` | zero-delay bypass; deterministic grant/deny; a denial writes nothing; key expiry; 24 competing callers on 6 connections never closer than the interval; 300-way burst = 1 grant |
| `hourly-limiter.integration.test.ts` | limit 3 of 10 concurrent = exactly 3; 200 attempts on 5 connections; replay; per-sender/campaign scopes; campaign cannot bypass global cap; all-or-nothing; UTC boundary; earlier-window release; idempotent refund |
| `email-processor.integration.test.ts` | all 12 state-transition cases (claim, duplicate job, skip, transient/permanent/uncertain, deferral not counted as attempt, stale reclaim, DB error after SMTP accepted) |
| `delivery.integration.test.ts` | full API -> BullMQ -> worker -> SMTP flow; interval across 2 workers; hourly 3-of-10 and 12-of-50 under 3 workers; backoff timing; permanent = 1 attempt; uncertain not retried; repeated recovery = 1 send; API/worker restart; graceful shutdown finishes in-flight work |
| earlier suites | config, health, scheduling/idempotency (incl. 50 simultaneous requests), schema, outbox, queue |

OAuth tests use mocked Google token-exchange and verification responses; no real credentials are required to run them.
Apply all checked-in migrations, including the transactional email search outbox trigger, with `npx prisma migrate deploy`.
The dashboard uses the authenticated email APIs; no demo inbox data is injected when the API is unavailable.

**Real Ethereal smoke test (run it yourself).** Sign in with Google in the frontend first. With `ETHEREAL_*` set (or empty for development auto-create), start the API and worker, then supply the session cookie:
```bash
curl -s -X POST localhost:4000/api/emails/schedule \
  -H 'Content-Type: application/json' -H 'Origin: http://localhost:3000' \
  -H 'Cookie: reachinbox.sid=<session-cookie-value>' \
  -d '{"from":"oliver.brown@domain.io","to":["someone@example.com"],"subject":"Ethereal smoke","bodyHtml":"<p>It works</p>"}'
```
Within a few seconds the row becomes `sent`; open its `previewUrl` (query above) or the Ethereal *Messages* page.

## Progress
| Area | Status |
|---|---|
| Scheduling API, idempotency, outbox, delayed BullMQ jobs, restart recovery | implemented and tested (real PostgreSQL + Redis) |
| Nodemailer/Ethereal delivery, failure classification, `sent` only after acceptance | implemented; tested against a real local SMTP server; **not tested against real Ethereal** |
| Global send interval (Redis Lua) | implemented and tested incl. multi-connection concurrency |
| Hourly limits (global/sender/campaign), durable deferral | implemented and tested incl. concurrent workers |
| Worker crash / stale-row recovery, uncertain-outcome handling | implemented and tested |
| Google OAuth/OIDC, Redis-backed sessions, strict-origin CORS/CSRF, email list/detail/count/cancel/star APIs | implemented; OAuth covered with mocked Google responses |
| Frontend integration | authenticated API-backed mailbox, search, counts, stars, compose/schedule, cancel and Slack connection UI |
| Slack OAuth, encrypted workspace connection and sender-hourly-limit notifications | implemented; Slack HTTP is mocked in tests, live workspace not verified |
| Elasticsearch email indexing, search, durable outbox recovery and reindex command | implemented; mocked tests pass, live service not verified |
| Bull Board monitoring | implemented; authorization and dashboard API tested with mocked queue operations; live Redis visibility not verified here |

## Known notes
- The initial migration SQL was written by hand (Prisma's schema engine could not be downloaded in the
  authoring sandbox) and applied to a real PostgreSQL 16 there. Run `npx prisma migrate dev` once on your
  machine: if Prisma reports drift, tell me and I will correct it.
- Prisma is pinned to 6.x with the Rust-free client (`engineType = "client"`) and the `pg` driver adapter.
- Checkpoint 3 Part 1 added migration `20261017000000_campaign_request_hash` (nullable `Campaign.requestHash`).
- Any address can currently be used as `from` (it creates a `Sender` for that owner). A sender allowlist tied to real SMTP
  identities, and a cap on senders per user, belong with the SMTP/rate-limit work - until then per-sender limits can be sidestepped by inventing senders.
- Recipient addresses are lowercased and must be ASCII; internationalized addresses are rejected.
- The 2 MB JSON body limit bounds practical batch size regardless of `MAX_RECIPIENTS_PER_BATCH`.
- Email attachment upload/delivery is not implemented by the backend; the frontend does not claim locally selected attachments were sent.
- Sandbox note: in the authoring sandbox `prisma generate` could not download engines (403), so it was run with dummy engine paths
  (`PRISMA_QUERY_ENGINE_LIBRARY`, `PRISMA_SCHEMA_ENGINE_BINARY`); the new migration was applied with `psql`. On a normal machine
  `npm install` + `npx prisma migrate deploy` work as documented.

### Known limitations (Checkpoint 11)
- **Live service end-to-end behavior remains unverified.** Docker was configured correctly but its daemon was not running in the verification environment; ports 4000, 5432, 6379, and 9200 were unavailable. The `docker compose up -d` and Prisma migration deployment attempts therefore could not start/connect to services.
- **The frontend has no dedicated test runner configured.** Validation used its TypeScript check and production Next.js build; backend API and queue tests remain separately covered.
- **Attachments remain unsupported by the backend.** The compose UI no longer simulates uploading or sending attachment blobs.
- **Live Bull Board queue visibility is unverified in this environment because Redis/Docker was unavailable.** Focused tests use a BullMQ `Queue` with mocked queue operations; run Redis and sign in as an allowlisted administrator to verify real waiting, active, delayed, completed and failed jobs.
- **Elasticsearch has not been integration-tested against a live service in this environment.** The included local service is available through `docker compose up -d`; search falls back to PostgreSQL and indexing retries from the outbox when Elasticsearch is unavailable.
- **Live Slack OAuth and notifications are unverified without Slack app credentials.** Tests mock Slack's OAuth and Web API responses; configure a real Slack app as described above for a live verification.
- **Real Google authentication is unverified without credentials.** The flow and claim/state rejection are covered with mocks; configure Google OAuth above for a live sign-in test.
- **Dependency audit:** frontend production audit reported no advisories. Backend `npm audit` reported 3 high-severity advisories through `prisma` / `@prisma/config` / `deepmerge-ts`; the available automatic fix is Prisma 7.10.1, a major upgrade intentionally not applied without compatibility testing.
- **Queue removal during cancellation is best-effort.** The database transition is atomic and authoritative; if Redis cannot remove an active job, the worker sees `cancelled` and skips it (`queueCleanupPending` is returned).
- **Real Ethereal is unverified.** Preview-URL extraction for configured accounts parses `[STATUSID ...]` from the SMTP reply and is unit-tested only.
- **Uncertain emails need a human.** They are marked `failed` with `UNCERTAIN:` and the Message-ID; there is no retry endpoint yet.
- **Redis total data loss.** The outbox covers a failed *handoff*, and AOF persistence covers restarts, but if Redis loses already-handed-off future jobs (e.g. flushed), they are not re-created automatically. `EmailQueue.ensureJob()` is the building block for a full re-sync.
- **Single Redis node only.** The Lua scripts derive keys from the Redis clock and are not Redis-Cluster-safe.
- **Spacing is measured at send start.** Arrival times at the SMTP server can differ by the handshake time (observed ~25 ms under a 500 ms interval).
- **Ordering is best-effort** among emails due at the same instant (workers race for the next slot); campaign `delayBetweenSeconds` staggering is deterministic.
- **Capacity is conservative.** A reservation is kept through transient retries and after any SMTP attempt.
- **`from` is still unrestricted**, so per-sender caps can be sidestepped by inventing senders (the global cap still holds).
- **Cancel** is available only before a scheduled email is claimed for processing; the worker safely skips a cancelled row and refunds unused capacity.
- The `20261019000000_smtp_attempt` migration was hand-written and applied to PostgreSQL 16 only; run `npx prisma migrate dev` once and report drift.
