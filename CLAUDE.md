# Treinoway Service

Node.js backend API for a wellness/training platform. **Fastify 5**, **Prisma 7** ORM, **PostgreSQL 17**, **ESM modules** throughout. Node.js 24+ and Docker required.

## Common Commands

```bash
npm run setup        # Install deps, start DB, migrations, generate Prisma client
npm run dev          # Development server with hot reload
npm run test         # All tests
npm run test:unit    # Unit tests only (excludes e2e)
npm run test:e2e     # E2E tests (fresh Postgres container)
npm run lint         # ESLint
npm run lint:fix     # ESLint with auto-fix

# Database (PostgreSQL on port 5433, not 5432)
npm run db:start     # Start PostgreSQL Docker container
npm run db:stop      # Stop container
npm run db:migrate   # Run Prisma migrations (dev)
npm run db:generate  # Regenerate Prisma Client
npm run db:studio    # Prisma Studio GUI (localhost:5555)
npm run db:reset     # Reset database (deletes all data)

# Single test file
npx vitest run test/services/auth-service.test.js
```

## Architecture

### Request Flow

Routes (`api/routes/`) → Auth Middleware (`api/middleware/auth.js`) → Services (`src/services/`) → Prisma Client (`src/db.js`) → PostgreSQL

### Key Layers

- **Routes** (`api/routes/`): Fastify routes with inline JSON schema validation (`api/schemas/`).
- **Auth Middleware** (`api/middleware/auth.js`): `verifyAuth` (session/JWT), `requireRole`/`checkRole` (RBAC). Roles: `STUDENT`, `TRAINER` in `src/constants/roles.js`. `/my/*` routes require auth only (no role).
- **Services** (`src/services/`): Business logic. Receive Prisma client or request context.
- **Database** (`src/db.js`): Single Prisma instance with `@prisma/adapter-pg`.
- **Schema** (`prisma/schema.prisma`): User, Account, Trainer, UserHealthDetail, Address, SocialNetwork, RefreshToken, PasswordResetToken, UserWaitlist, UserPreferences, TrainingProtocol, etc.

### Authentication

- **Web**: Server-side sessions (`@fastify/session`), cookie-based, 7-day TTL.
- **Mobile**: JWT bearer tokens, refresh token rotation (`@fastify/jwt`).
- **OAuth**: Google OAuth2, backend-for-frontend pattern — backend exchanges code, creates session, redirects with cookie.

## API Conventions

- Use `verifyAuth` for protected routes, `checkRole` for RBAC.
- JSON schema validation on request/response in every route.
- Rate limiting: global 100 req/min (disabled in test). Per-endpoint limits configured via `config/environments/*.js` (e.g., postal code: 10/min, upload avatar: 5/min, become trainer: 3/hour).
- Swagger docs at `/docs`.
- CORS: dev allows all origins, production validates env URLs.
- Plugins: cookie, session, JWT, OAuth2, Swagger.

## Error Handling

All error responses follow a unified contract:

```json
{
  "error": "SOME_ERROR_CODE",
  "messageCode": "some.semantic.code",
  "message": "Human-readable fallback message",
  "details": {}
}
```

### Rules

1. Throw errors from services/middlewares — do not return ad-hoc payloads.
2. Use `AppError` (`src/errors/app-error.js`) for domain errors.
3. Keep `messageCode` stable for client i18n.
4. 4xx: meaningful `message`. 5xx: never expose internals.
5. Validation errors: `error: "VALIDATION_ERROR"`, `messageCode: "validation.failed"`, `details` array.
6. Error normalization is centralized in `api/server.js` (`setErrorHandler` + `onSend` fallback).
7. Do not introduce legacy `error.code` / `error.statusCode` patterns.
8. Route schemas (`api/schemas/`) must include `error`, `messageCode`, `message`, `details` in error responses.

## Date Handling

- **Date-only fields** (`birthDate`, `startDate`, `endDate`, any `@db.Date`): format with `formatDateOnly()` from `src/helpers/date-helpers.js` → returns `"YYYY-MM-DD"` string. This prevents timezone shift bugs (e.g., Dec 18 becoming Dec 17 in UTC-3).
- **DateTime fields** (`createdAt`, `updatedAt`, etc.): keep as-is (ISO timestamp).
- **Input**: `new Date(stringValue)` for date-only input (existing pattern, leave as-is).

## Development Standards

Every new route MUST update both:
- **Postman collection**: `postman/Treinoway.postman_collection.json`
- **Swagger docs**: via JSON schemas in route definitions

Every new feature MUST include:
- **Unit tests** for services and business logic
- **E2E tests** when the feature involves API endpoints or integration flows

### Code Quality

- **Single Responsibility**: Each function/module should do one thing well. Services handle business logic, routes handle HTTP concerns.
- **Constants over loose strings**: Use named constants (`src/constants/`) for error codes, roles, status values, and any repeated string literals. Never scatter raw strings across the codebase.
- **Dependency Inversion**: Services receive dependencies (Prisma client, external clients) via injection — do not import singletons directly inside business logic.
- **Meaningful naming**: Variables, functions, and files should clearly express intent. Avoid abbreviations and generic names (`data`, `result`, `info`).
- **No magic numbers/strings**: Extract configuration values and thresholds into constants or config files.
- **Small, focused functions**: Prefer composing small functions over writing large monolithic ones. If a function grows beyond ~30 lines, consider extracting helpers.
- **DRY with judgement**: Extract shared logic into reusable helpers, but only when there are 3+ real usages — premature abstraction is worse than duplication.

## Testing

- **Framework**: Vitest, Node environment. `DISABLE_EMAIL=true` and `NODE_ENV=test` set in `vitest.config.js`.
- **Unit tests**: `test/services/`, `test/middleware/`. Mock Prisma and external deps with `vi.mock()`. Mocks auto-restored/cleared/reset between tests.
- **E2E tests**: `test/e2e/`. Run against real Postgres via `scripts/test-e2e.sh`.

## Environment

- Copy `.env.example` to `.env` for local development.
- `DISABLE_EMAIL=true` skips email sending (Resend) — always true in tests.
- Email config: `src/config/email-handler.js`.
- CI/CD: GitHub Actions (`lint.yml`, `unit-tests.yml`, `e2e-tests.yml`). Pre-commit: Husky + lint-staged.

---

> **Maintenance**: If this file exceeds ~150 lines, split into root `CLAUDE.md` (overview + commands) and sub-folder `CLAUDE.md` files (`api/`, `src/`, `test/`).
