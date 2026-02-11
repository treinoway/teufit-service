# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Treinoway Service is a Node.js backend API for a wellness/training platform built with **Fastify 5**, **Prisma 7** ORM, and **PostgreSQL 17**. It uses ESM modules throughout.

## Common Commands

```bash
# Initial setup (install deps, start DB, run migrations, generate Prisma client)
npm run setup

# Development server with hot reload
npm run dev

# Run all tests
npm run test

# Run unit tests only (excludes e2e)
npm run test:unit

# Run a single test file
npx vitest run test/services/auth-service.test.js

# Run e2e tests (spins up a fresh Postgres container)
npm run test:e2e

# Lint
npm run lint
npm run lint:fix

# Database commands
npm run db:start          # Start PostgreSQL Docker container
npm run db:stop           # Stop PostgreSQL container
npm run db:migrate        # Run Prisma migrations (dev)
npm run db:generate       # Regenerate Prisma Client after schema changes
npm run db:studio         # Open Prisma Studio GUI (localhost:5555)
npm run db:reset          # Reset database (deletes all data)
```

## Architecture

### Request Flow

Routes (`api/routes/`) → Middleware (`api/middleware/auth.js`) → Services (`src/services/`) → Prisma Client (`src/db.js`) → PostgreSQL

### Key Layers

- **Routes** (`api/routes/`): Fastify route definitions with JSON schema validation (`api/schemas/`). Routes register request/response schemas inline.
- **Auth Middleware** (`api/middleware/auth.js`): `verifyAuth` checks session (web) or JWT (mobile). `checkRole` enforces RBAC with roles `STUDENT` and `TRAINER` (defined in `src/constants/roles.js`).
- **Services** (`src/services/`): Business logic layer. Each service receives the Prisma client or request context. Services handle auth flows, user management, trainer profiles, token lifecycle, and signup.
- **Database** (`src/db.js`): Single Prisma client instance using `@prisma/adapter-pg` for native PostgreSQL connection pooling.
- **Schema** (`prisma/schema.prisma`): Core models are `User`, `Account` (OAuth), `Trainer`, `Student`, `StudentHealthDetail`, `Address`, `SocialNetwork`, `RefreshToken`, `PasswordResetToken`, `UserWaitlist`, `UserPreferences`.

### Authentication

Two auth strategies coexist:
- **Web**: Server-side sessions via `@fastify/session` (cookie-based, 7-day TTL)
- **Mobile**: JWT bearer tokens with refresh token rotation via `@fastify/jwt`
- **OAuth**: Google OAuth2 using backend-for-frontend pattern — backend exchanges code, creates session, redirects to frontend with cookie

### Server Configuration (`api/server.js`)

Fastify server with plugins: CORS (dynamic origin validation), rate limiting (100 req/min), cookie, session, JWT, OAuth2, Swagger (`/docs`). CORS behavior differs between development (allows all origins) and production (validates against env URLs).

## Testing

- **Framework**: Vitest with Node environment
- **Unit tests**: `test/services/` and `test/middleware/` — mock Prisma and external deps with `vi.mock()`
- **E2E tests**: `test/e2e/` — run against a real Postgres container via `scripts/test-e2e.sh`
- **Test env vars**: `DISABLE_EMAIL=true` and `NODE_ENV=test` are set automatically in `vitest.config.js`
- Mocks are auto-restored/cleared/reset between tests

## Development Standards

**CRITICAL**: These standards MUST be followed for all code changes:

### Documentation Requirements
- **Every new route** MUST update both:
  - Postman collection (`postman/Treinoway.postman_collection.json`)
  - Swagger documentation (via JSON schemas in route definitions)

### Testing Requirements
- **Every new feature** MUST include:
  - Unit tests for services and business logic
  - E2E tests when the feature involves API endpoints or integration flows

## Environment

- Requires **Node.js 24+** and **Docker** (for PostgreSQL)
- PostgreSQL runs on port **5433** (not default 5432)
- Copy `.env.example` to `.env` for local development
- `DISABLE_EMAIL=true` skips email sending (Resend service) — always true in tests
- Email service uses **Resend** (`src/config/email-handler.js`)

## CI/CD

GitHub Actions workflows run on push to master and PRs to master/staging:
- `lint.yml` — ESLint
- `unit-tests.yml` — Unit tests
- `e2e-tests.yml` — E2E tests with Docker Postgres

Pre-commit hook via Husky + lint-staged runs ESLint on staged JS/TS files.
