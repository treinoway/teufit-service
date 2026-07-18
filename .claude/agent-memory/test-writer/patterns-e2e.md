---
name: E2E test patterns
description: App bootstrap, auth helpers, and TrainerStudent setup patterns used across E2E tests
type: feedback
---

## App bootstrap

All E2E test files follow this pattern:

```js
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

e2eDescribe('e2e: ...', () => {
  let app;
  beforeAll(async () => { app = await setupApp(); });
  afterAll(async () => { if (app) await app.close(); });
  beforeEach(async () => { await cleanDatabase(); });
});
```

## Creating a linked trainer-student pair in E2E

To test `hasActiveTrainer: true`, create a trainer via `/become-trainer` and link the student via `POST /trainer/students`:

```js
async function createTrainerAndLinkStudent(app, studentEmail) {
  // 1. Signup a trainer user
  const signupRes = await app.inject({ method: 'POST', url: '/auth/signup', payload: { email, password } });
  const { token: { accessToken: rawToken } } = signupRes.json();

  // 2. Become trainer (returns new token)
  const becomeRes = await app.inject({ method: 'PATCH', url: '/become-trainer', headers: { authorization: `Bearer ${rawToken}` } });
  const { token: { accessToken: trainerToken } } = becomeRes.json();

  // 3. Link student by email
  await app.inject({ method: 'POST', url: '/trainer/students', headers: { authorization: `Bearer ${trainerToken}` }, payload: { email: studentEmail } });
}
```

Note: `/become-trainer` returns a **new** accessToken — always use the token from the `PATCH /become-trainer` response for subsequent trainer calls, not the signup token.

## Auth helper pattern

Use unique email suffixes with `Date.now()` to avoid conflicts across parallel test runs:

```js
const email = `e2e+<feature>-<role>-${Date.now()}@example.com`;
```

## Mocking a service dependency in E2E tests

When a route handler calls a service that makes external network calls (e.g. Apple JWKS, Firebase), mock the service module with `vi.mock()` at the top of the E2E test file. Vitest hoists `vi.mock()` so the mock intercepts the import inside the route file as well. Pattern:

```js
vi.mock('../../src/services/apple-id-token-service.js', () => ({
  verifyAppleIdToken: vi.fn(),
}));
import { verifyAppleIdToken } from '../../src/services/apple-id-token-service.js';

// In each test:
verifyAppleIdToken.mockResolvedValue({ subject, email, emailVerified, isPrivateEmail });
// or:
const err = new Error('...'); err.code = 'ERR_JWT_EXPIRED'; verifyAppleIdToken.mockRejectedValue(err);
```

Reset between tests with `vi.clearAllMocks()` in `beforeEach`.

## Plan-gated routes (since commit `94710ca`, 2026-05-17)

Trainers created via `POST /auth/signup` + `PATCH /become-trainer` have no `PlatformSubscription` row and default to the FREE tier (`studentCap: 3, aiActionsPerStudent: 0, championships: false, branding: false` — `src/constants/platform-plan.js`). Any route whose service calls into `src/services/platform-plan-service.js` (`assertStudentCap`, `assertCanUseBranding`, `assertCanCreateChallenge`, `assertCanUseAi`, `assertStudentActiveOnPlan`) will 403 with a `platformPlan.*` messageCode for a freshly-created trainer.

If a test needs a fully-unlocked trainer, call the shared helper right after resolving `trainer.id`:

```js
import { provisionTrainerPlan } from '../helpers/platform-plan.js';

const trainer = await prisma.trainer.findUnique({ where: { userId }, select: { id: true } });
await provisionTrainerPlan(trainer.id); // defaults to DIAMOND — unlocks every gate
```

Only wire this into a file's `createTrainerWithToken()` after confirming (isolated run + reading the response body's `messageCode`) that its failures are actually `platformPlan.*` gate cascades — see [[known-failures]] for the list of files already checked. Don't apply it reflexively; some failures that look similar (missing `TrainerStudent` link, unrelated schema drift) are not plan-tier issues at all.

## Security-fix regression tests: assert state, not just statusCode

For fail-closed/auth-bypass fixes (e.g. the Asaas webhook secret validation, `src/helpers/asaas-webhook-helpers.js` + `api/routes/asaas-webhook-route.js`), a test that only asserts `res.statusCode === 401` does NOT prove the exploit is closed — it would still pass even if the handler processed the forged payload and mutated the DB before returning 401. Always pair the statusCode assertion with a direct DB assertion that the forged mutation did not happen (e.g. `platformSubscription.tier` stayed `FREE`, no `platformSubscriptionPayment` row was created for the forged `asaasPaymentId`). See `test/e2e/asaas-webhook.e2e.test.js` describe block `'exploit regression: forged tier upgrade must not mutate state'`.

## `messageCode` on security/M2M routes must not reuse generic user-facing codes

`auth.unauthorized` translates (via `preSerialization` hook + `src/i18n/locales/*.js`) to a *user session* message ("Sessão expirada. Faça login novamente."). Reusing it for a machine-to-machine 401 (e.g. Asaas webhook secret mismatch) produces a misleading translated `message` even though the `error`/`status` look fine. When a route is M2M/webhook-only, give it its own `messageCode` (e.g. `webhook.invalidSecret` in `ASAAS_WEBHOOK_ERRORS.INVALID_SECRET`, `src/constants/platform-plan.js`) with matching locale entries in both `pt-BR.js` and `en-US.js`. When writing/updating E2E tests for such routes, assert `messageCode` explicitly (`toMatchObject({ error, messageCode })`), not just `statusCode` — a bare statusCode assertion won't catch a future accidental reuse of a generic code.

## SubscriptionPlan / StudentSubscription / SubscriptionPayment / TrainingProtocol fixtures — create directly via Prisma, not through mutation routes

Established in `trainer-dashboard.e2e.test.js`, reused in `trainer-student.e2e.test.js` (readiness/`blockers` tests). These fixtures need exact control over `dueDate` / `cycleEndDate` / `expirationDate` / `startDate` boundaries that a mutation route wouldn't let you set directly, so bypass the API and use `prisma.<model>.create()`:

```js
function daysFromToday(days) {
  const today = getDateOnlyAsMidnightUtc(new Date());
  return addDaysMs(today, days); // both from src/helpers/date-helpers.js
}

async function createPlan(trainerId, overrides = {}) {
  return prisma.subscriptionPlan.create({
    data: { trainerId, name: '...', recurrence: 'monthly', price: 100, ...overrides },
  });
}
async function createSubscription(trainerId, studentId, planId, overrides = {}) {
  return prisma.studentSubscription.create({
    data: { trainerId, studentId, planId, recurrence: 'monthly', price: 100,
      startDate: daysFromToday(-60), status: SubscriptionStatus.ACTIVE, ...overrides },
  });
}
async function createPayment(subscriptionId, overrides = {}) {
  return prisma.subscriptionPayment.create({
    data: { subscriptionId, cycleStartDate: daysFromToday(-30), cycleEndDate: daysFromToday(0),
      dueDate: daysFromToday(0), amount: 100, status: PaymentStatus.PENDING, ...overrides },
  });
}
async function createProtocol(trainerId, assigneeId, overrides = {}) {
  return prisma.trainingProtocol.create({
    data: { trainerId, assigneeId, name: '...', status: 'active', startDate: daysFromToday(-60), ...overrides },
  });
}
```

`TrainerStudent.activeOnPlan` defaults to `true` in the schema and a freshly-created trainer (via signup + `/become-trainer`) is within their free-tier seat quota by default, so a plain `POST /trainer/students` link doesn't need an explicit `activeOnPlan` override to produce a "ready" student — only override it when the test specifically wants the `blocked_on_plan` case.

## Fastify `additionalProperties: false` does NOT cause 400

Fastify 5 uses AJV with `removeAdditional: true` by default (confirmed in `node_modules/fastify/build/build-validation.js`). Extra fields in the request body are silently stripped — the server returns 2xx, not 400. Do NOT write tests asserting `statusCode 400` because a prescription/unknown field was sent. Instead, assert:
- The response is 201/200
- The response body does NOT contain those extra fields

But a **missing required** field is NOT forgiven by `removeAdditional` — that still throws AJV's `required` error → 400, regardless of what other (stripped) extra fields were present. This matters when a test sends a wrong-shaped body to a 401/403 test (see below).

## Body-schema validation runs at different points relative to auth depending on whether auth is global or route-local

`api/server.js` wraps almost every route module (`trainerRoutes`, `nutritionistPatientRoutes`, `userRoutes`, etc.) in one `fastify.register(async (fastify) => { fastify.addHook('onRequest', authenticate); ... })` block (around line 326-360). Fastify's lifecycle is `onRequest → preParsing → preValidation → Validation → preHandler → Handler`. So:
- **Missing/invalid auth** → caught by the global `onRequest` hook, which runs *before* body validation → correctly returns 401 even if the test's payload is garbage/wrong-shaped for the route's schema.
- **Wrong role** (`requireRole(...)` in the route's own `preHandler` array) runs *after* body validation. If the test's payload doesn't satisfy the route's body schema (e.g. missing a required field), AJV rejects it with 400 *before* `requireRole` ever runs — the test will get 400, not the expected 403.

Practical rule for writing "returns 403 when wrong role" tests: always send a schema-valid body (right shape, right required fields), even though the value's specific content doesn't matter for a role test — see `trainer-student.e2e.test.js`'s `returns 403 when the user does not have the TRAINER role` test, which sends `payload: { email: 'anyone@example.com' }` rather than an empty or wrong-shaped object. A "401 without authentication" test, by contrast, can get away with a garbage body precisely because the global `onRequest` auth hook short-circuits before validation.

## Nutritionist/trainer "link by X" endpoints use email, not internal ID

`POST /nutritionist/patients` and `POST /trainer/students` both link by the **patient/student's email** in the request body (`{ email }`, not `{ patientId }` / `{ studentId }`) — confirmed in `src/services/nutritionist-patient-service.js` (`linkPatient(db, nutritionistUserId, email, data)`) and `src/services/trainer-service.js` (`linkStudentByEmail`). The internal user ID is only used in URL path params for unlink/list-item/metabolic-profile operations, never in the link-creation body. If an E2E test for one of these link endpoints sends `{ patientId }`/`{ studentId }` in the body, that's a stale test, not a source bug — fix the test to look up `email` from the helper that creates the patient/student user (most of these helpers already return `email` alongside `userId`).
