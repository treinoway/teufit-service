---
name: Unit test mock patterns
description: Prisma mock structure, beforeEach defaults, and toEqual shape pinning for user-service tests
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
