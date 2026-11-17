# Prod Env Setup — treinoway-service (Railway)

> Status: **not ready**. Prod environment is barely provisioned. Findings from
> inspecting Railway project `treinoway_service` on 2026-07-17. No secrets in
> this file — values redacted intentionally.

## Current state of prod

Railway project: `treinoway_service` (id `fe86126b-2d69-4924-bc29-a98807e37716`).

Environment **production** has only 2 services:
- `treinoway-service` — the backend app. **Zero app env vars set** (only Railway's
  auto-injected `RAILWAY_*`). The "outdated service running" has no app config.
- `treinoway-service-db-prod` — Postgres 17. Healthy. Exposes `DATABASE_URL`,
  `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `PG*`.

Environment **staging** (reference) has: `treinoway-web`, `treinoway-db-staging`,
`treinoway-service-staging`.

## 3 infra blockers (do these FIRST — 8 env vars depend on them)

1. **No S3 bucket in prod.** Staging uploads use a Railway **Bucket** (object
   storage on `t3.storageapi.dev`, bucket `treinoway-staging-vn5qtby`). Prod has
   none → avatar/image upload will break. Create a Railway Bucket for prod, then
   read its 5 creds into `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
   `AWS_DEFAULT_REGION`, `AWS_ENDPOINT_URL`, `AWS_S3_BUCKET_NAME`.
   (Fallback only: `DISABLE_S3_UPLOAD=true` — loses upload feature.)
2. **Backend prod has no domain.** `treinoway-service` has no deployment/domain
   yet → `BACKEND_URL` and `GOOGLE_OAUTH_CALLBACK_URL` can't be finalized until a
   domain is generated.
3. **No web service in prod.** Staging has `treinoway-web`; prod doesn't →
   `FRONTEND_URL` unknown until the prod web is deployed.

## Two bugs carried in staging config — do NOT copy to prod

1. **`SESSION_SECRET` is the placeholder.** Staging uses
   `"your-secret-key-change-this-in-production"` (the value from `.env.example`).
   JWTs are signed with it (`api/server.js:287` — `JWT_SECRET || SESSION_SECRET`,
   and there is no `JWT_SECRET`). Publicly-known secret = forgeable tokens.
   **Prod must generate a fresh secret:** `openssl rand -base64 48`.
2. **Sentry is off in staging.** Staging sets `DSN_ENTRY`, but the code reads
   `process.env.SENTRY_DSN` (`instrument.js:13` → `config.sentry.dsn`). `DSN_ENTRY`
   is read nowhere, so `SENTRY_ENVIRONMENT` / `SENTRY_TRACES_SAMPLE_RATE` do
   nothing there. **Prod must use the var name `SENTRY_DSN`.**

## Env var plan for prod

### Set via Railway reference (confirmed working)
```bash
DATABASE_URL="${{treinoway-service-db-prod.DATABASE_URL}}"
```

### Copy literal from staging (env-agnostic)
`HOST`, `PORT`, `LLM_PROVIDER`, `OTEL_EXPORTER_OTLP_ENDPOINT`,
`OTEL_EXPORTER_OTLP_HEADERS`, `ANTHROPIC_API_KEY`,
`RESEND_API_KEY`.
(AI/Resend keys: reuse works; separate prod keys better for quota isolation — optional.)

### Change for prod (you provide the value)
| Var | Value |
|---|---|
| `NODE_ENV` | `production` |
| `SESSION_SECRET` | **new** `openssl rand -base64 48` (not the placeholder) |
| `FIREBASE_PROJECT_ID` | prod Firebase project (staging: `teufit-staging`) |
| `APPLE_BUNDLE_ID` | `treinoway.com.br.treinoway` (staging: `br.com.teufit.app.stg`) |
| `GOOGLE_OAUTH_CLIENT_ID` | prod OAuth client (or reuse staging's) |
| `SENTRY_DSN` | prod Sentry DSN (var name fix — not `DSN_ENTRY`) |
| `SENTRY_ENVIRONMENT` | `production` (staging: `beta`) |
| `SENTRY_TRACES_SAMPLE_RATE` | `0.1` (staging: `1.0` — prod samples to stay in quota) |
| `FRONTEND_URL` | prod web URL — **blocker #3** |
| `BACKEND_URL` | prod backend URL — **blocker #2** |
| `GOOGLE_OAUTH_CALLBACK_URL` | `<backend-prod>/auth/google/callback` — **blocker #2** |
| `AWS_ACCESS_KEY_ID` | from prod Bucket — **blocker #1** |
| `AWS_SECRET_ACCESS_KEY` | from prod Bucket — **blocker #1** |
| `AWS_DEFAULT_REGION` | from prod Bucket — **blocker #1** |
| `AWS_ENDPOINT_URL` | from prod Bucket — **blocker #1** |
| `AWS_S3_BUCKET_NAME` | from prod Bucket — **blocker #1** |

### Optional: manager (backoffice) read-only client
The `/admin/manager/*` routes use their own small read-only pool (`application_name=teufit-manager`),
so backoffice queries never compete with app traffic for connections. All optional; defaults work with no config.
```bash
ADMIN_DATABASE_URL=<read replica URL>   # default: DATABASE_URL (same primary)
ADMIN_DB_POOL_MAX=2                      # default 2
ADMIN_DB_STATEMENT_TIMEOUT_MS=5000       # default 5000; queries above this (or waiting for a pool connection) return 503 admin.queryTimeout
```
`ADMIN_DATABASE_URL` must NOT point at a transaction-mode PgBouncer: the startup `options`
(read-only, statement timeout) would be silently dropped. Use a direct or session-mode connection.
All 8 manager routes share one rate-limit bucket (60 req/min per client).

### Langfuse (iArnold tracing)

One Langfuse project; the `environment` field separates staging from production. Tracing turns on only when `NODE_ENV` is `staging`/`production` and both keys are set.

| Variable | staging | production |
|---|---|---|
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | keys of the shared project | same keys |
| `LANGFUSE_BASE_URL` | `https://us.cloud.langfuse.com` (US — same jurisdiction as Anthropic; keys must come from a US-region project. Unset = SDK default EU) | same |
| `LANGFUSE_TRACING_ENVIRONMENT` | optional (defaults to `staging`) | optional (defaults to `production`) |
| `LANGFUSE_CONTENT_MODE` | `full` allowed | `masked` (default; never `full` without LGPD sign-off) |

What each `LANGFUSE_CONTENT_MODE` exports:
- `masked`: the student-focus block (anamnesis), student names in the trainer roster and in the active-protocol assignee lines, and e-mail addresses are redacted (REF ids kept). User messages, conversation history, model replies and tool inputs/outputs are exported as is: they can contain student names and free text typed by the trainer. Error status messages carry only error name, status and codes, never the raw message.
- `full`: everything as is, including raw error messages.
- `off`: no input or output is exported (metadata, usage, timings and levels only).

Railway's deployment draining time (`RAILWAY_DEPLOYMENT_DRAINING_SECONDS` / the service draining setting) must be at least 10 s on staging and production, or buffered spans are lost on deploy.

`LANGFUSE_FORCE_LOCAL` is for local debugging only. Check that Railway staging runs `NODE_ENV=staging` before relying on this.

### Do NOT set
- `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` — the app never reads them
  (only `DATABASE_URL`; the `POSTGRES_*` are docker-compose-local only). Staging
  sets them redundantly; skip in prod.
- `JWT_SECRET` — optional, falls back to `SESSION_SECRET`.
- `DISABLE_EMAIL` / `DISABLE_S3_UPLOAD` / `DISABLE_POSTAL_CODE_VALIDATION` — leaving
  them unset keeps email/upload/validation ON (correct for prod).
- `BETA_INVITE_GATE_ENABLED` — leaving it unset keeps the closed-beta invite gate ON
  (default `true`). Decision: prod and staging both keep the gate enabled, so this
  should stay unset in both. If it's ever set explicitly, note it now accepts
  true/false, 1/0, yes/no, on/off, case-insensitive/trimmed (not just the exact
  string `"false"`).
- `ASAAS_API_KEY` / `ASAAS_WEBHOOK_SECRET` / `ASAAS_ENV` — Asaas not live. **Warning:**
  the day `ASAAS_API_KEY` is set in prod WITHOUT `ASAAS_WEBHOOK_SECRET`, the server
  refuses to boot (intentional — `src/helpers/asaas-webhook-helpers.js:34`).
- `ENABLE_BRIEFING_CRON` — the daily briefing cron auto-enables when
  `NODE_ENV=production` (`api/server.js:380`). Expect it to run in prod with no var.
- `ENABLE_SUBSCRIPTION_CYCLE_CRON` — the daily subscription-cycle generation cron
  (03:00 America/Sao_Paulo) auto-enables when `NODE_ENV=production`; set `true` to
  run it elsewhere. Idempotent, safe with multiple instances.
- `GIT_COMMIT` — Railway injects at build (falls back to package version).
- `FRONTEND_REDIRECT_URL` — optional, falls back to `FRONTEND_URL`.

## Deploy note: subscription_payments.cycle_index
Migration `20261005120000_add_payment_cycle_index` adds `cycle_index INTEGER NOT NULL`
(no default). Old instances insert payments without it and will fail — deploy the
migration and the new code together, without a rolling overlap of old/new instances
(stop old instances, migrate, start new ones).

## Note: staging has no `GOOGLE_OAUTH_CLIENT_SECRET`
Staging runs with only `GOOGLE_OAUTH_CLIENT_ID` — web Google login goes through
Firebase; `@fastify/oauth2` is the mobile BFF path. Prod can run without the secret
too, unless the Google mobile BFF flow is needed.

## Suggested order for tomorrow
1. Create prod Railway Bucket → fill the 5 `AWS_*`.
2. Generate a domain for `treinoway-service` (prod) → set `BACKEND_URL` +
   `GOOGLE_OAUTH_CALLBACK_URL`.
3. Decide/deploy prod web → set `FRONTEND_URL`.
4. `openssl rand -base64 48` → `SESSION_SECRET`.
5. Prod Sentry DSN → `SENTRY_DSN` (+ `SENTRY_ENVIRONMENT=production`,
   `SENTRY_TRACES_SAMPLE_RATE=0.1`).
6. Prod Firebase project → `FIREBASE_PROJECT_ID`.
7. Copy the env-agnostic set from staging.
8. Run DB migrations against prod DB before first real traffic.

## Handy commands
```bash
railway link --project treinoway_service --environment production
railway variables --service treinoway-service --environment production --kv   # inspect
railway variables --service treinoway-service --environment production --set 'KEY=VALUE'  # set one
```
