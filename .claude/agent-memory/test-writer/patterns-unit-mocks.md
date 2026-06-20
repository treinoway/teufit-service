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

## Lock-ordering assertions for $queryRaw

To verify `$queryRaw` fires BEFORE the first exercise write, compare `invocationCallOrder`:

```js
expect(txMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
  txMock.exercise.create.mock.invocationCallOrder[0],
);
```

This works because Vitest assigns monotonically increasing `invocationCallOrder` values across all `vi.fn()` mocks in the same test.
