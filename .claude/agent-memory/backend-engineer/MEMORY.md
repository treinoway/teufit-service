# Backend Engineer Agent Memory

## Key Patterns

### Enum-like constants (no Prisma enums)
All enum-like values are stored as `String` in Prisma schema and validated at runtime via frozen constant objects in `src/constants/training.js`. Always follow this pattern:
1. Add frozen object + values array to `src/constants/training.js`
2. Add `validateXxx()` to `src/helpers/training-validators.js` (same signature as `validateTrainingLevel`)
3. Import and call in service functions

### Migration drift resolution (dev environment)
When `prisma migrate dev` fails due to drift (missing local migration file or checksum mismatch):
1. Check which migrations are applied in DB: `docker exec treinoway_postgres psql -U treinoway_user -d treinoway_db -c "SELECT migration_name FROM _prisma_migrations ORDER BY started_at DESC"`
2. Create the missing migration SQL file locally
3. Update checksums in DB to match local files:
   - Get local checksum: `shasum -a 256 prisma/migrations/<name>/migration.sql`
   - Update DB: `UPDATE _prisma_migrations SET checksum = '<hash>' WHERE migration_name = '<name>'`
4. Then run `npm run db:migrate -- --name <name>` normally

### DB container
- Container name: `treinoway_postgres`
- Credentials: user=`treinoway_user`, password=`treinoway_password`, db=`treinoway_db`
- Port: 5433

### importFromTemplate — new field inheritance pattern
When adding a new optional field to `TrainingProtocol`, always add it to `importFromTemplate` using:
```js
fieldName: data.fieldName !== undefined ? data.fieldName : template.fieldName,
```
Not the `??` operator, because `??` does not distinguish between "not provided" and "explicitly set to null".

## File Map

- Constants: `src/constants/training.js`, `src/constants/anamnesis.js`
- Validators: `src/helpers/training-validators.js`
- Protocol service: `src/services/training-protocol-service.js`
- Template service: `src/services/training-protocol-template-service.js`
- Anamnesis shared helpers: `src/services/anamnesis-shared.js`
- Anamnesis services: `src/services/anamnesis-service.js`, `src/services/admin-anamnesis-service.js`
- Anamnesis shared schemas: `api/schemas/anamnesis-shared.schema.js`
- Protocol schemas: `api/schemas/training-protocol-route.schema.js`
- Template schemas: `api/schemas/training-protocol-template-route.schema.js`
- Frontend brief: `.claude/frontend-brief.md`
- DB cleanup helper: `test/helpers/db-cleanup.js`

## db-cleanup.js: add new tables before their parents (Restrict FK)
When adding models with `onDelete: Restrict`, always add them to `test/helpers/db-cleanup.js` BEFORE the parent table. Current order for anamnesis: `anamnesis_answers` → `anamnesis_responses` → `student_anamneses` → `anamnesis_question_options` → `anamnesis_questions` → `anamnesis_sections` → `anamneses`.

## Reorder endpoints: validate IDs belong to the target entity
Any endpoint that accepts a list of IDs for reordering MUST verify those IDs belong to the parent entity before updating. Otherwise callers can update records across entity boundaries. See `validateSectionIds` in `src/services/anamnesis-shared.js` as the canonical implementation.

## AppError subclass behavior — CRITICAL
`NotFoundAppError`, `ForbiddenAppError`, `ConflictAppError` **hardcode their `error` field** (`NOT_FOUND`, `FORBIDDEN`, `CONFLICT`) and do NOT expose an `error` override. Passing `error: 'CUSTOM_CODE'` to them is silently ignored.

In the anamnesis services, we always use `new AppError({ httpStatus, error, messageCode, message })` directly. This means you CAN and SHOULD assert on `error` in tests for anamnesis domain errors:
```js
// CORRECT (anamnesis services use AppError directly)
await expect(fn()).rejects.toMatchObject({ httpStatus: 404, error: 'ANAMNESIS_NOT_FOUND', messageCode: 'anamnesis.notFound' });
```

For OTHER services that still use subclasses without overriding `error`, only assert on `httpStatus` and `messageCode`.

## Fastify route registration order
Static segments must be registered **before** dynamic ones sharing the same prefix:
```js
// CORRECT ORDER:
fastify.patch('/anamneses/:id/sections/reorder', ...); // static "reorder" first
fastify.patch('/anamneses/:id/sections/:sectionId', ...); // then dynamic
```

## Prisma P2002 (unique constraint) handling
```js
catch (error) {
  if (error.code === 'P2002') throw new ConflictAppError({ messageCode: '...', message: '...' });
  throw error;
}
```

## Server route registration location
All protected routes are inside `buildServer()` in `api/server.js`, inside the block:
```js
await fastify.register(async (fastify) => {
  // ...existing routes...
  await fastify.register(newRoutes); // add here
});
```

## `verifyTrainerStudentLink` in anamnesis-service
Despite the parameter name `trainerId`, this function actually receives a **userId** (not trainer.id).
It internally calls `findTrainerOrThrow(userId)`. All callers pass `userId`, not `trainer.id`.
When adding new service functions that need trainer-student verification, pass the raw `userId`.

## Custom 409 errors (domain-specific conflict codes)
Use `AppError` directly — NOT `ConflictAppError` — when the error code must be a custom domain code:
```js
throw new AppError({
  httpStatus: 409,
  error: AnamnesisErrorCode.ANAMNESIS_HAS_STUDENT_LINKS,
  messageCode: AnamnesisMessageCode.ANAMNESIS_HAS_STUDENT_LINKS,
  message: '...',
});
```
`ConflictAppError` hardcodes `error: 'CONFLICT'` and ignores the `error` override.

## Prisma mock completeness
When adding new Prisma models or methods to a service, also add them to the `vi.mock` in the test file.
Missing mock methods cause `TypeError: prisma.x.y is not a function` at test runtime.
New methods added for anamnesis: `studentAnamnesis.count`, `studentAnamnesis.findFirst`, `anamnesisResponse.*`, `anamnesisAnswer.*`

## Admin role in E2E tests
No `become-admin` endpoint. Pattern:
```js
const updatedUser = await prisma.user.update({ where: { id: userId }, data: { roles: ['admin'] } });
const adminToken = app.jwt.sign({ sub: updatedUser.id, email: updatedUser.email, roles: ['admin'], status: updatedUser.status });
```

## Pre-validate before $transaction (admin service pattern)
When validation (e.g., `validateQuestionType` inside `buildQuestionsCreateData`) must be testable WITHOUT mocking `$transaction`, pre-compute the sections/questions data structure outside the transaction. This makes validation throw synchronously before entering the transaction.

## copyAnamnesis vs forkAnamnesis distinction
- **Fork** (`/fork`): only own private anamneses, `version = source.version + 1`, `parentId = source.id`
- **Copy** (`/copy`): public OR own private, `version: 1`, `parentId: null` — completely independent

## S3 image upload — do NOT wrap in try/catch
Do not wrap `s3BucketHandler.uploadFile` + `prisma.model.update` in a try/catch that catches generic errors and re-throws as a new AppError. The global error handler deals with unexpected errors. Only catch to handle specific expected cases. Fire-and-forget `deleteFile` should always be outside any try/catch.

## Pre-existing failing E2E tests (updated 2026-04-10)
- `test/e2e/admin-anamnesis.e2e.test.js` — 1 test failing
- `test/e2e/anamnesis.e2e.test.js` — 1 test failing
- `test/e2e/import-primecoaching.e2e.test.js` — 3 tests failing
- `test/e2e/ai.e2e.test.js` — 1 test failing (multi-turn conversation)
These are NOT caused by new features. Do not investigate unless specifically asked.

## i18n schema migrations (PR2, 2026-04-10)
- `protocolStatus` locale namespace is an empty placeholder — `TrainingProtocol.status` uses `TrainingStatus` enum, so map to `trainingStatus` namespace
- PR1-era unit tests in `test/i18n/` assumed empty namespaces (fallback = raw value) — update those assertions when the namespace is populated
- When `workoutSessionDetailSchema` and `workoutSessionListItemSchema` spread `workoutSessionSchema.properties`, they automatically inherit any `*Label` fields added to that base schema
- `exerciseLogSchema.exercise` is `nullable: true` — label-walker handles null gracefully at runtime (`applyAtPath` returns early on null nodes)
- `anamnesisQuestionType` namespace is now POPULATED (PR3, 2026-04-10). `questionSchema.type` uses `i18nField('type', 'anamnesisQuestionType')` in `anamnesis-shared.schema.js`. The `typeLabel` sibling is present in all question response shapes. Both `questionBodySchema.type` (request) and all non-question `type` fields are intentionally untouched.

## i18n infrastructure (PR1, 2026-04-10)
- `x-i18n` extension key SURVIVES Fastify 5.7 schema compilation — readable at `request.routeOptions.schema.response[statusCode]` in onRequest hooks. No side-map needed.
- `buildErrorPayload(error, { language })` — language is optional; no translation when absent (keeps tests backward-compatible).
- Both the `setErrorHandler` path AND the preSerialization-error path must translate. The preSerialization hook uses a local `translateErrorPayloadMessage` helper in server.js.
- When adding i18n to a codebase, pre-existing E2E tests that assert specific English message text will break. Fix by removing the fragile `message` assertion and keeping only `error`/`messageCode` checks.
- Follow PT-BR accents rule in locale files: always `ã`, `é`, `ç`, `õ`, etc.

## Date helpers: two distinct functions for two purposes
- `parseDateOnlyAsUtc(str)` → noon UTC — use for storing `@db.Date` fields (avoids timezone day shift)
- `getDateOnlyAsMidnightUtc(date|str)` → midnight UTC — use for ranking/challenge window boundary comparisons
Do NOT use `parseDateOnlyAsUtc` for boundaries — it yields noon, which would be off by 12h.

## Gamification: TRAINER_BONUS uses null referenceId by design
Multiple bonuses to the same student are intentional. `NULL != NULL` in PostgreSQL so the `@@unique([action, referenceId])` constraint does not block them. Do not upsert bonus transactions.

## Gamification: student-facing endpoints use trainer's userId as query param
`GET /my/points?trainerId=<uuid>` accepts the trainer's `User.id` (userId), not their `Trainer.id`. Routes resolve internally via `prisma.trainer.findUnique({ where: { userId } })`. This is consistent for all `/my/` gamification endpoints.

## Derived status pattern (not stored)
Challenge status (`scheduled/active/completed/cancelled`) is computed on read from `cancelledAt`, `startDate`, `endDate`. Not stored in DB. See `deriveStatus()` in `challenge-service.js`.

## PointBalance increment is atomic
`prisma.pointBalance.upsert({ update: { totalPoints: { increment: N } } })` generates atomic SQL. No race condition under concurrent awards.

## Prisma 7.x groupBy panic — `having: {}` crashes the query engine
**Symptom**: `PrismaClientRustPanicError` / "entered unreachable code" at `group_by.rs:136`
**Root cause**: Empty `having: {}` in a `groupBy()` call hits an unreachable branch in Prisma 7's query compiler.
**Fix applied in `ranking-service.js`**:
1. Removed the empty `having: {}` (it was a no-op with a stale comment).
2. Replaced the second `groupBy` (used to find latest transaction per student for inactivity filter) with `findMany` + JS `reduce` — avoids a second groupBy with a different where + aggregation combination, which is another known panic trigger.
**Challenge ranking**: unaffected (no `having`, no second `groupBy`).
