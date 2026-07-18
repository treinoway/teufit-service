---
name: Unit test mock patterns
description: Prisma mock structure, beforeEach defaults, toEqual shape pinning, and deadlock-retry tx mock patterns
type: feedback
---

## Prisma mock for user-service

The `vi.mock('../../src/db.js')` block for user-service must include ALL Prisma models the service touches. As of the `hasActiveTrainer` feature, that includes:

```js
prisma: {
  user: { findUnique: vi.fn(), update: vi.fn() },
  userPreferences: { upsert: vi.fn() },
  trainer: { findFirst: vi.fn(), create: vi.fn() },
  trainerStudent: { findFirst: vi.fn() },   // <-- required for computeHasActiveTrainer
}
```

Missing any model causes `TypeError: Cannot read properties of undefined (reading 'findFirst')` at runtime.

## beforeEach default for trainerStudent

Always seed a default return value in `beforeEach` so happy-path tests that don't care about trainer links don't need to set it up:

```js
beforeEach(() => {
  vi.clearAllMocks();
  prisma.trainerStudent.findFirst.mockResolvedValue(null); // no trainer link by default
});
```

## toEqual shape pinning for user profile

`toUserProfile()` always includes `hasActiveTrainer: boolean` in the returned object. Any test using `toEqual` with the exact profile shape MUST include `hasActiveTrainer` in the expected object. Tests using `toMatchObject` are unaffected.

**Why:** After the `hasActiveTrainer` feature landed, two existing `toEqual` tests broke because the expected shape was missing the field. Use `toMatchObject` for partial assertions or keep `toEqual` shapes complete.

## exercise-service tx mock — lockTrainingForUpdate ($queryRaw)

`exercise-service.js` calls `lockTrainingForUpdate(tx, trainingId)` as the FIRST statement inside EVERY `prisma.$transaction(...)` callback. That function calls `tx.$queryRaw\`SELECT id FROM trainings ...\``. Every tx mock passed to `prisma.$transaction.mockImplementation(async (fn) => fn(txMock))` MUST include:

```js
$queryRaw: vi.fn().mockResolvedValue([]),
```

Without it, Vitest throws `TypeError: tx.$queryRaw is not a function` for all 45 tests that exercise a code path going through a transaction.

This applies to ALL tx mocks in `test/services/exercise-service.test.js`, including:
- Helper functions (`makeCreateTxMock`, `makeLibraryTxMock`, `makeIntensityTxMock`, `makeDeleteTxMock`, `makeUpdateTxMock`, `makeTxMock`)
- Inline `{ exercise: { update: vi.fn() } }` objects inside `setupHappyPath`, superset tests, `reorderSubstitutes`, `reorderSupersetMembers`, and `addSubstitute` blocks
- The inline `tx = { ... }` objects built inside `prisma.$transaction.mockImplementation` closures for `addSubstitute` tests

## updateExercise now uses a transaction

`updateExercise` previously called `prisma.exercise.update` directly. After the deadlock-fix refactor it wraps the update in `prisma.$transaction(async (tx) => { ... })`. Tests that checked `prisma.exercise.update` must now:
1. Build a `txMock` with `$queryRaw`, `exercise.update`, `exercise.findMany`, `training.update`
2. Wire `prisma.$transaction.mockImplementation(async (fn) => fn(txMock))`
3. Assert on `txMock.exercise.update` / `txMock.training.update` instead of the prisma singleton methods
4. Tests that assert the operation was NOT called (error paths that throw before the tx) should check `prisma.$transaction` was not called instead of `prisma.exercise.update`

## Testing a service that delegates to an already-tested service (e.g. trainer-dashboard-service → briefing-service)

When Service B calls an already-unit-tested `Service A` function (e.g. `getBriefingByTrainerId` from `briefing-service.js`), mock Service A's module wholesale with `vi.mock()` rather than building the full Service A prisma-mock tree. This isolates Service B's own query-shape/response-mapping logic from Service A's internals (already covered in its own test file).

If Service A also exports a small pure helper Service B needs (e.g. `startOfCurrentMonth()`), don't stub it to a hardcoded constant — reimplement its real logic inline in the mock factory so it still tracks `vi.useFakeTimers()` / `vi.setSystemTime()` correctly in every test, without needing to keep a hardcoded date in sync per-test:

```js
vi.mock('../../src/services/briefing-service.js', () => ({
  getBriefingByTrainerId: vi.fn(),
  startOfCurrentMonth: vi.fn(() => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }),
}));
```

## Testing DB-side count/aggregate-only services (no row transfer, no JS bucketing)

For a service where every KPI is a single `prisma.<model>.count()` / `.aggregate()` call (no `findMany` + JS reduction), the "business logic" IS the where-clause — assert on `mock.calls[n][0]` directly (`toEqual` the full where object) rather than just asserting the returned number. This is the only way to unit-test date-boundary conventions (inclusive `lte` vs exclusive `lt`) since a mocked `count()` will happily return any number you tell it regardless of what where-clause was actually passed.

Call order across `Promise.all([...])` array elements is deterministic in Vitest: each async function runs synchronously up to its first `await`, so the N-th element's first prisma call lands at `mock.calls[N-1]` in array order — no need for `mockImplementation` dispatch-by-shape unless two KPIs share the exact same mocked method AND you can't rely on array position (e.g. calls nested inside a helper that itself does 2+ sequential calls to the same method — then use `mockResolvedValueOnce` chains in call order instead).

Semantics a mocked `prisma.count()` CANNOT verify (real-DB/SQL guarantees, not JS logic) — cover these in the E2E suite instead, and just assert the where-clause shape in the unit test:
- `relation: { some: {...} }` / `{ none: {...} }` correctly evaluating false against a row with zero related children (e.g. an active subscription with 0 payments never matching `payments.some`)
- `field: { lt: x }` / `{ gte: x }` naturally excluding rows where `field IS NULL` (e.g. `expirationDate: null` protocols never matching either bucket)

## `vitest.config.js` has `mockReset: true` — factory-level `.mockResolvedValue()` defaults get wiped before EVERY test

`vitest.config.js` sets `restoreMocks: true, clearMocks: true, mockReset: true`. `mockReset` strips the implementation (not just call history) of every `vi.fn()` before each test — including ones set inline in the `vi.mock('../../src/db.js', () => ({ ... }))` factory itself (e.g. `trainingProtocol: { findMany: vi.fn().mockResolvedValue([]) }`). That factory-level default only survives for module-load time; by the first `it()` it's already gone. Any default return value a describe block relies on MUST be re-established in that describe's own `beforeEach`:

```js
beforeEach(() => {
  vi.clearAllMocks();
  prisma.trainingProtocol.findMany.mockResolvedValue([]);
  prisma.workoutSession.groupBy.mockResolvedValue([]);
});
```

Corollary: when a service starts calling a Prisma model it didn't before, you must add BOTH (1) the model/method key to the `vi.mock` factory object (else `Cannot read properties of undefined (reading 'findMany')`) AND (2) a default `mockResolvedValue` in the relevant `beforeEach` if other tests in that block rely on it resolving to something falsy-safe (usually `[]`).

## Same mocked method called twice in one function with different `where` shapes

When a service (e.g. `listStudents` in `trainer-service.js`) calls `prisma.trainingProtocol.findMany` twice in the same `Promise.all([...])` — once for an adherence window query, once for a separate "has active protocol" check with a different `where` — Vitest's call order for that one mock follows the synchronous construction order of the `Promise.all` array (each promise-producing call runs synchronously up to its first `await`). Chain `mockResolvedValueOnce` twice to give each call a distinct return value, in the same order they appear in the array:

```js
prisma.trainingProtocol.findMany
  .mockResolvedValueOnce([])              // 1st call: adherence query
  .mockResolvedValueOnce([{ assigneeId: 's1' }]); // 2nd call: active-protocol check
```

This is a variant of the existing `Promise.all` call-order note above — here it's the SAME mocked method called twice (not two different methods), so `mockResolvedValueOnce` chaining (not array position across different mocks) is the right tool.

## Lock-ordering assertions for $queryRaw

To verify `$queryRaw` fires BEFORE the first exercise write, compare `invocationCallOrder`:

```js
expect(txMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
  txMock.exercise.create.mock.invocationCallOrder[0],
);
```

This works because Vitest assigns monotonically increasing `invocationCallOrder` values across all `vi.fn()` mocks in the same test.
