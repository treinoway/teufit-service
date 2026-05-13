---
name: Mocked Prisma masks real DB violations
description: backend-engineer's unit tests fully mock prisma.$transaction, so writes that violate column types or FKs pass tests but crash in prod
type: feedback
---

When backend-engineer asserts "all tests pass," verify any new write path against the actual Prisma column types. Recurring failure modes:

- Writing fractional/decimal values (e.g. `order + 0.5`) to `Int` columns. Mocked tx accepts it; Postgres rejects.
- New FKs with `ON DELETE NO ACTION` colliding with existing `Cascade` from a parent table — invisible until a real cascade fires.

**Why:** Real bug — `substituteExerciseLog` wrote `principal.order + 0.5` into `ExerciseLog.order` (`Int`); test passed because `prisma.$transaction.mockImplementation` accepted any value. Same review found `exercises_substitute_for_exercise_id_fkey` with `NO ACTION` while `Training → Exercise` cascades.

**How to apply:** When reviewing a new write path, open `schema.prisma` and check (1) the actual column type of every field being written, (2) cascade direction of every new FK against parents that already cascade. Don't trust unit tests with mocked `$transaction`.
