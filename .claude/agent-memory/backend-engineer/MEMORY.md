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

## Legacy route error handler gap (2026-04-29)
Routes in `api/routes/` use try/catch with explicit `error.code` checks. `AppError` errors with codes NOT in the list fall to the 500 catch-all. When adding new service validation errors (e.g. `VALIDATION_ERROR`), add handling to the route:
```js
if (error.code === 'VALIDATION_ERROR') {
  return reply.status(400).send({
    error: error.error ?? error.code,
    messageCode: error.messageCode ?? 'validation.failed',
    message: error.message,
  });
}
```
This does NOT apply to routes already using throw-through (rare) or `setErrorHandler`.

## importFromTemplate prescriptionMode pattern (2026-04-29)
Both `resolvePrescriptionMode` AND `applyPrescriptionModeExclusivity` must be called when copying junction rows to Exercise in `training-service.importFromTemplate`. Without exclusivity, legacy rows with both fields set create dirty Exercise snapshots.

## Pre-existing failing E2E tests (updated 2026-04-23)
- `test/e2e/admin-anamnesis.e2e.test.js` — 1 test failing
- `test/e2e/import-primecoaching.e2e.test.js` — 3 tests failing
- `test/e2e/ai.e2e.test.js` — 1 test failing (multi-turn conversation)
- `test/e2e/auth.e2e.test.js` — 2 tests failing (INVALID_CREDENTIALS messageCode)
- `test/e2e/nutritionist-patient.e2e.test.js` — multiple failures
- `test/e2e/workouts-today.e2e.test.js` — 2 failures
These are NOT caused by new features. Do not investigate unless specifically asked.

## Fastify serialization: JSONB / free-form objects need additionalProperties: true
When a Prisma `Json?` field appears in a Fastify response schema, the schema object variant MUST declare `additionalProperties: true`. Without it, fast-json-stringify strips all properties → `{}`.
```js
// CORRECT
{ anyOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] }
```
Affects: `condition` (conditional questions), `config` (question config), and any Json? field.

## fork/copy: individual option creates, not createMany
Two-pass fork/copy uses `tx.anamnesisQuestionOption.create` (not `createMany`) to get new IDs for remapping. Unit test mocks must use `anamnesisQuestionOption: { create: vi.fn() }` and `anamnesisQuestion: { create: vi.fn(), update: vi.fn() }`.

## CONDITIONAL_DEPTH_EXCEEDED test scenario
Intermediate question in depth test must be ELIGIBLE type (DICHOTOMOUS/SINGLE_CHOICE/MULTIPLE_CHOICE). Otherwise PARENT_NOT_ELIGIBLE fires first.

## Snapshot pattern for junction tables (2026-04-15)
When a junction table needs independent copies of related entity fields:
1. Add all fields as nullable in schema first (migration: nullable → backfill → NOT NULL).
2. Create a `buildJunctionCreateData(e, index, template)` helper: uses `e.field !== undefined ? e.field : template.field` for every field so callers can override any field at link time.
3. Service must fetch full ExerciseTemplate data (not just `select: { id: true }`) before creating junction rows.
4. AI service reads exercise display data from junction row fields directly (`e.name`, `e.sets`), NOT from `e.exerciseTemplate.name`.
5. When updating AI test mocks: `exerciseTemplate.create` must return full field data; junction row mocks must include all snapshot fields at top level.

## Route file inline error handling pattern (training-template-route.js)
This file uses the OLD inline try/catch with `error.code` checks, not the newer propagation pattern (challenge-route.js). Follow whichever pattern already exists in the file you are editing.

## Custom migration with backfill (NOT NULL columns in populated table)
Use `npx prisma migrate dev --create-only --name <name>`, edit the SQL: add nullable → UPDATE JOIN → ALTER SET NOT NULL. Then `npm run db:migrate`.

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

## Sub-agent invocation (2026-04-16, updated 2026-05-15)
`test-writer`, `api-docs-sync`, `backend-code-reviewer` are project-level agents in `.claude/agents/`. They are NOT invokable via the `Skill` tool or `RemoteTrigger`. Write tests and update docs directly when these agents cannot be invoked by the Skill tool.

## Vitest: do NOT spread asymmetric matchers (2026-05-16)
`{ ...expect.objectContaining(...), key: value }` throws `PrettyFormatPluginError: Asymmetric matcher Object does not implement toAsymmetricMatcher()`. Always flatten all properties in `toMatchObject`:
```js
// WRONG: { ...expectPlanError(err), details: {...} }
// CORRECT:
await expect(fn()).rejects.toMatchObject({
  error: err.code, messageCode: err.messageCode, httpStatus: err.status, details: {...},
});
```

## computeCycleEndDate — billing cycle date algorithm (2026-05-15)
Shared helper: `src/helpers/subscription-helpers.js`. Two-path algorithm:
1. If `startDay > lastDayOfTargetMonth` → return `Date.UTC(y, targetMonth, lastDayOfTargetMonth)` (overflow clamp — last day of target month).
2. Otherwise → return `Date.UTC(y, targetMonth, startDay) - 24*60*60*1000` (next billing - 1 day).
`targetMonth = d.getUTCMonth() + months` (0-indexed; JS handles year rollover automatically).
`lastDayOfTargetMonth = new Date(Date.UTC(y, targetMonth+1, 0)).getUTCDate()` (day 0 trick).
Examples: May 1 monthly → May 31. Jan 31 monthly → Feb 28/29. Aug 31 monthly → Sep 30. Feb 28 monthly (leap) → Mar 27.
DO NOT use `Date.UTC(y, m+months, startDay, 12, 0, 0) - 1 day` — silently overflows on 31-day starts.

## subscription-service import chain (2026-05-15)
`subscription-payment-service` → imports `computeAmount` from `student-subscription-service`
`student-subscription-service` → imports `validateDiscount` from `subscription-plan-service`
`subscription-plan-service` → no service imports
`validateDiscount` is EXPORTED from `subscription-plan-service.js`. Call it in `assignPlanToStudent` after resolving effective discounts to catch mutual-exclusion violations even when one side is 0.

## Decimal.js not installed — use Prisma.Decimal (2026-05-15)
`decimal.js` is NOT in `package.json`. Use `import { Prisma } from '@prisma/client'` → `const { Decimal } = Prisma` for currency arithmetic in services and test mocks.
`Decimal('100.00').toString()` returns `'100'` not `'100.00'`. In tests that check money output, use `Number(result.price)` instead of string equality.

## POST route with optional body schema must be nullable (2026-05-15)
When a POST route body is optional (e.g. cancel with optional reason), either omit the `body` schema entirely or add `nullable: true` to the body object schema. Without it, a POST request with no body sends `null`, which fails Fastify's `{ type: 'object' }` validation with a 400 before the service is reached.

## Partial unique indexes: raw SQL only (2026-05-15)
Prisma does not support partial unique indexes (`WHERE ...`). After `prisma migrate dev`, apply the index manually:
```
docker exec treinoway_postgres psql -U treinoway_user -d treinoway_db -c "CREATE UNIQUE INDEX IF NOT EXISTS idx_name ON table (col) WHERE status = 'active';"
```
Also add the SQL to the migration file so it's part of the changeset in git.

## Onboarding milestone hooks: test mock requirements (2026-04-16)
When adding `maybeMarkFirstProtocolCreated` (or any onboarding helper) to a NEW service, the service's test file must mock `trainer-onboarding-service.js`:
```js
vi.mock('../../src/services/trainer-onboarding-service.js', () => ({
  maybeMarkFirstProtocolCreated: vi.fn().mockResolvedValue(undefined),
}));
```
Also add `trainer.updateMany` to any existing Prisma mock that doesn't have it — missing methods cause `TypeError: db.trainer.updateMany is not a function`.

## Frontend OnboardingChecklistCard is already built (2026-04-16)
`treinoway-web/src/components/OnboardingChecklistCard/` and `treinoway-web/src/hooks/useOnboardingStatus.js` are fully implemented. When extending backend semantics for an existing milestone (e.g., adding template creation as a trigger for `firstProtocolCreated`), no frontend changes are needed — the i18n copy already covers it ("Monte um treino do zero ou use um template").

## Virtual alias pattern in user-relations (2026-04-16)
`ALLOWED_USER_RELATIONS` is a `Set` derived from `USER_RELATION_CONFIGS` keys. For virtual aliases (fields from a related model, not a direct Prisma sub-relation), add the alias name to the Set separately (not to `USER_RELATION_CONFIGS`), then handle it with a dedicated `if` block in `buildUserSelect`. The `toUserProfile` mapper must guard with `if (user.X !== undefined)` since the field is only present when that alias was requested.

## Workout of the Day (2026-04-18)
New service at `src/services/workout-of-the-day-service.js`. Key helpers:
- `getWeekdayInTimeZone(date, tz)` in `date-helpers.js` — uses `Intl.DateTimeFormat` with `weekday: 'long'` lowercase.
- `addDaysInTimeZone(date, days)` in `date-helpers.js` — adds ms (no tz arg needed, weekday evaluated via Intl).
- `resolveTimeZone(header)` in `src/helpers/timezone.js` — validates via Intl try/catch, fallback `America/Sao_Paulo`, never 400.
- `trainingResponseSchema`, `importedExerciseResponseSchema`, `trainingWithExercisesResponseSchema` are now **exported** from `api/schemas/training-route.schema.js`.

## prescriptionMode mutual exclusivity pattern (2026-04-29)
When adding a mode-driven mutual exclusivity field (e.g. `prescriptionMode`):
1. Add `validatePrescriptionMode(mode, data)` in validators — use `new AppError(...)` directly (NOT `buildError`) so error/messageCode are correct.
2. Add `resolvePrescriptionMode(mode, exercise)` — infers mode from existing data when DB field is null (mirrors backfill SQL).
3. Add `applyPrescriptionModeExclusivity(mode, data)` — returns only `{ repetitions, duration }` with the opposing field nulled.
4. In create paths: `const resolvedMode = data.prescriptionMode ?? PrescriptionMode.REPS` before `applyPrescriptionModeExclusivity`.
5. In update paths: if `prescriptionMode` is provided → apply exclusivity and set all three fields; otherwise handle `repetitions`/`duration` independently.
6. Normalize on all read returns: `{ ...record, prescriptionMode: resolvePrescriptionMode(record.prescriptionMode, record) }`.
7. Template-copy flows inherit via `resolvePrescriptionMode(template.prescriptionMode, template)` — NOT raw `template.prescriptionMode`.
8. Existing unit tests that use `expect(result).toEqual(mock)` break when normalization adds a field — fix by adding the field to the mock return value.

## Timezone in dashboard service (2026-05-03)
- `resolveTimeZone(request.headers['app-timezone'])` → pass as `{ ...request.query, timeZone }` to service.
- Service signature: `{ dateFrom, dateTo, timeZone = 'America/Sao_Paulo' }`.
- In `$queryRaw` template literals: `DATE(col AT TIME ZONE ${timeZone})` — Prisma parameterizes safely; `resolveTimeZone` already validated the value.
- `GROUP BY` in daily-activity query also uses `${timeZone}` (both SELECT and GROUP BY must match).
- Unit tests mock `$queryRaw` and cannot assert on template-literal params. Test that: (a) option accepted without throw, (b) dates returned by mock are passed through as-is (no JS re-bucketing). E2E layer is where actual bucketing correctness must be verified.
- Dashboard indexes added: `@@index([assigneeId, status, startDate(sort: Desc)])` + `@@index([trainerId])` on `TrainingProtocol`; `@@index([trainingId])` on `Exercise`. Migration: `20260503231518_add_protocol_and_exercise_indexes`.

## Truthy checks for nullable Prisma fields in services (2026-05-10)
Use `if (field)` / `if (!field)` (truthy) instead of `=== null` / `!== null` for nullable DB fields.
Prisma returns `null` from DB but unit test mocks may return `undefined`. Truthy checks handle both.
ESLint flags `if (Boolean(field))` as `no-extra-boolean-cast` — use plain `if (field)`.

## validateSubstituteConstraint: CANNOT_BE_IN_SUPERSET checks CANDIDATE, not principal (2026-05-10 — P1 fix)
- `substituteCannotBeInSuperset`: checks `candidate.supersetGroupId` (the substitute being added) — bi-set PRINCIPALS CAN have substitutes
- `substituteCannotChain`: checks `principal.substituteForExerciseId` — principals that are themselves substitutes cannot have sub-substitutes
- Plan edge case #4: "If student substitutes a bi-set member, the substitute log replaces only that member in the workout flow."

## addSubstitute: findFirst + create inside $transaction (2026-05-10)
Both the `substituteOrder` lookup and the `create` must run inside a single `$transaction` to prevent race conditions. Test mocks must provide `tx.exercise.findFirst` and `tx.exercise.create`.

## deleteExercise: clearGroupIfUndersized inside $transaction (2026-05-10)
`clearGroupIfUndersized` logic (check remaining count + updateMany) now runs inside the delete transaction. Test mocks must provide `tx.exercise.findMany` to return the remaining members after the delete step.

## Float order in ExerciseLog is invalid — use integer shift (2026-05-10 — C1 fix)
`ExerciseLog.order` is `Int`. Never use `order + 0.5`. Pattern: `updateMany` to shift logs with `order > principalLog.order` by `+1`, then `create` at `principalLog.order + 1`. All in a single `$transaction`.

## Session response: exercise.substitutes[] is the authoritative source for swap options (2026-05-10 — C4 fix)
All session-returning service functions (startSession, getSession, updateSession, getStudentSession) must include `substitutes: { where: { deletedAt: null }, orderBy: { substituteOrder: 'asc' } }` in the exercise select. The frontend reads swap options from `exerciseLogs[].exercise.substitutes[]`, NOT from `/my/trainings/:trainingId/exercises`.

## updateExercise schema does not accept supersetGroupId (2026-05-10)
`exerciseUpdateBodyProperties` excludes `supersetGroupId` and `supersetOrder` to prevent bypassing contiguity validation. Set them only at exercise creation time (`POST .../exercises`).

## reorderSupersetMembersSchema has minItems: 2 (2026-05-10)
Sending an empty `exerciseIds` array returns 400, not 404. Always pass at least 2 valid UUIDs to reach the service-layer 404 for a non-existent group.

## Existing test mocks with old timestamps break when staleness logic is added (2026-05-12)
When adding time-based staleness checks (e.g. `Date.now() - startedAt >= 24h`), existing test mocks that use hardcoded historical timestamps (e.g. `new Date('2025-04-01')`) will unexpectedly trigger the stale branch. Fix: update `makeSession()` callers in the affected tests to pass `startedAt` within the fresh window relative to the mocked system time. Use `vi.setSystemTime` consistently and pass explicit `startedAt` that is clearly within the fresh range.

## logger not threaded: routes MUST pass `request.log` to services (2026-05-12)
When a service accepts an optional `logger` param for graceful-degradation logging (e.g. `tryAutoCompleteSession`), the route handler MUST pass `logger: request.log`. Without it, failures are silently swallowed with no observability. Pattern:
```js
const result = await myService(userId, { ..., logger: request.log });
```

## Transaction wrapping for recompute hooks (2026-05-13)
When wrapping an existing non-transactional create in `prisma.$transaction` to add a recompute step, all test cases that stub `prisma.exercise.create.mockResolvedValue(x)` must be migrated to provide a `txMock` with `exercise.create`, `exercise.findMany`, and `training.update`. Failing to do so causes `TypeError: Cannot read properties of undefined (reading 'update')`.

## trainingResponseSchema propagation (2026-05-13)
Adding `estimatedDurationSeconds` to `trainingResponseSchema.properties` automatically propagates to `trainingWithExercisesResponseSchema` (spread) and from there to `workouts-today-route.schema.js`. No other schema files needed updating.

## Fastify serializer drops fields missing from schema — two-layer check required (2026-05-12)
`fast-json-stringify` silently strips response fields not declared in `properties`. When a field is stored in DB but never reaches the frontend, check:
1. **Schema** (`api/schemas/`) — is the field declared in `properties`?
2. **Service Prisma `select`** — if using `select: { ... }`, is the field explicitly listed?

Example: `estimatedDurationSeconds` was stored but dropped because:
- Protocol schemas: `trainingItemSchema` didn't declare it → schema fix alone was sufficient (protocol service uses `include:` not `select:`)
- Workout-session service: all 6 call sites used `training: { select: { id, name, category } }` → field was never fetched from DB

Key distinction: `include: { relation: { where, orderBy } }` returns ALL scalar fields; `include: { relation: { select: { ... } } }` returns ONLY listed fields.

When two inline object shapes are identical, extract to a named const to prevent future drift.

## Briefing feature patterns (2026-05-15)
- `TrainerBriefingSnapshot` table: one row per trainer, `trainer_briefing_snapshots`.
- `briefing-service.js` receives prisma via injection — unit tests pass mock prisma directly, NO `vi.mock('../../src/db.js')`.
- `computeReturningThisWeek` short-circuits: if `recentStudentIds.length === 0`, gap check is skipped → only 3 `workoutSession.findMany` calls total, not 4.
- E2E 401/403 assertions: do NOT assert `body.error === 'UNAUTHORIZED'`. The auth middleware returns the message string in `error`. Use `toBeDefined()` only.
- Add new table `trainer_briefing_snapshots` to `test/helpers/db-cleanup.js` before `users` table.
- When adding `trainerBriefingSnapshot` to an existing `vi.mock` of `../../src/db.js`, add `updateMany: vi.fn().mockResolvedValue({ count: 0 })` to it.
- Mark briefing dirty AFTER a `$transaction` commits, not inside it.
- Cron enabled only when `NODE_ENV=production` OR `ENABLE_BRIEFING_CRON=true`. Do not enable in tests.

## Asaas billing patterns (2026-05-16)
- DB enum `PlatformBillingType`: only `PIX | CREDIT_CARD | BOLETO` (no UNDEFINED)
- `billingType` on `PlatformSubscriptionPayment` is NOT nullable — always call `normalizeBillingType()` before insert
- `dueDate` on `PlatformSubscriptionPayment` is NOT nullable — always call `parseDueDate()` before insert
- Webhook secret: `asaas-access-token` header is a literal string match (no HMAC)
- Tier encoded in Asaas `externalReference` as `tier:TIER:trainer:UUID` — parse via `parseTierFromExternalReference()`
- Tier flip happens ONLY on `PAYMENT_CONFIRMED` webhook, NOT on checkout
- Past-due grace: check-on-read in `getTrainerPlan()` — no cron needed. 7-day grace (`PAST_DUE_GRACE_DAYS`)
- Pre-existing lint count: 16 errors (as of 2026-05-16)
- Platform plan rate limits at `config.rateLimit.platformPlan`
- Asaas config at `config.asaas` (apiKey, webhookSecret, env)

## Adherence helpers extraction (2026-05-18)
- Shared helper: `src/helpers/adherence-helpers.js` — exports `WEEKDAY_TO_INT`, `DAY_MS`, `countWeekdayOccurrences`, `computeExpectedSessions`.
- `briefing-service.js` now imports from the helper and re-exports `DAY_MS/WEEKDAY_TO_INT/countWeekdayOccurrences` for backward compat (currently unused by any active consumer).
- `trainer-service.js` imports `computeExpectedSessions` directly from the helper; no longer imports the 3 lower-level symbols.
- `getDashboardSummary` changed from `trainingProtocol.findFirst` → `trainingProtocol.findMany` (all active protocols in window). Unit tests must mock `trainingProtocol.findMany`, not `findFirst`.
- Weekday date arithmetic pitfall: `countWeekdayOccurrences` snaps start to UTC midnight — a mid-day start STILL counts that day, and the end is EXCLUSIVE. Verify expected occurrences manually before writing assertions (enumerate the actual dates).

## AJV v8: nullable enums on input schemas need type array (2026-06-10)
`nullable: true` is ignored by AJV v8 (Fastify 5) on **request body/query** schemas.
For any optional enum that can be null, use: `{ type: ['string', 'null'], enum: [...values, null] }`.
Response schemas: `nullable: true` still works (fast-json-stringify handles it).
Affected fields: `intensity`, `bodySegment`, `weekDay` in `training-protocol-route.schema.js`.

## importFromTemplate must stay in sync with createProtocolWithTrainings (2026-06-10)
Both flows build nested exercise create-data. The single canonical helper is `buildNestedExerciseCreateData`
in `training-protocol-service.js`. Both paths use it — adding a new exercise field only requires touching this one function.
Both paths also compute `estimatedDurationSeconds` per training via `estimateWorkoutDuration({ exercises: createData })`.
If a refactor removes `buildNestedExerciseCreateData`, re-add it; do NOT return to the inline object pattern.

## preSerialization hook: 503 data responses get corrupted (2026-06-14)
The error-normalizing preSerialization hook (step 2 in server.js) processes ALL responses with
statusCode >= 400. A route returning a 503 data payload (not an error) will have its payload
fields overwritten (`messageCode`, `error`, `message` injected). Guard the hook at the top:
```js
const route = request.routeOptions?.url ?? request.url;
if (reply.statusCode < 400 || route === '/health') { done(null, payload); return; }
```
For new routes that return semantic 4xx/5xx data (not errors), add a similar exclusion.

## Sentry + onResponse hook (2026-06-14)
- `@sentry/node@10.x` installed. `Sentry.init` at module scope after all imports, gated by `config.sentry.dsn`.
- `captureException` in `setErrorHandler` ONLY when `isServerError` (5xx) AND `config.sentry.dsn` is set.
- `onResponse` structured log: `{ requestId, method, url, statusCode, durationMs, userId }`. Skip `/health`.
- Config keys: `config.sentry.dsn`, `config.sentry.environment`. Env vars: `SENTRY_DSN`, `SENTRY_ENVIRONMENT`.

## /health route registration (2026-06-14)
`healthRoutes` must be registered BEFORE the `async (fastify) => { fastify.addHook('onRequest', authenticate) }`
plugin scope in server.js — otherwise authenticate runs on /health and blocks unauthenticated monitors.
Current position: after `asaasWebhookRoutes`, before the protected routes block.

## Prisma 7.x groupBy panic — `having: {}` crashes the query engine
**Symptom**: `PrismaClientRustPanicError` / "entered unreachable code" at `group_by.rs:136`
**Root cause**: Empty `having: {}` in a `groupBy()` call hits an unreachable branch in Prisma 7's query compiler.
**Fix applied in `ranking-service.js`**:
1. Removed the empty `having: {}` (it was a no-op with a stale comment).
2. Replaced the second `groupBy` (used to find latest transaction per student for inactivity filter) with `findMany` + JS `reduce` — avoids a second groupBy with a different where + aggregation combination, which is another known panic trigger.
**Challenge ranking**: unaffected (no `having`, no second `groupBy`).
