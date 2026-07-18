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

## Call-order mocks make `where`-clause tests vacuous (read paths)

Same root cause on the read side. When a service calls the same Prisma method twice with *different* `where` shapes, backend-engineer stubs them with
`prisma.x.findMany.mockResolvedValueOnce(A).mockResolvedValueOnce(B)`. Vitest resolves those **by call order, not by arguments** — so the test passes no matter what the `where` clauses actually say. The test *name* claims to cover the business rule; the assertion covers nothing.

**Why:** Real finding — `listStudents` (trainer-service.js) deliberately issues two `trainingProtocol.findMany` calls: the adherence one filters `startDate: { lt: now }`, the `no_active_protocol` blocker one must NOT. The unit test "does not flag no_active_protocol for a protocol that has not started yet" used `mockResolvedValueOnce([]).mockResolvedValueOnce([{assigneeId:'s1'}])`. I reintroduced the exact forbidden `startDate` filter into the blocker query and **all 46 tests still passed**.

**How to apply:** Whenever the headline business rule lives in a `where` clause (date boundaries, inclusive-vs-exclusive, a filter that must be *absent*), unit tests with a mocked client cannot prove it. Demand either (a) an explicit argument assertion — `toHaveBeenNthCalledWith(n, expect.objectContaining({ where: ... }))` / `expect.not.objectContaining` for filters that must be absent — or (b) an E2E test with real fixtures straddling the boundary. Cheap verification: sabotage the clause, re-run the suite, see if anything goes red. If it stays green, the coverage is theatre.
