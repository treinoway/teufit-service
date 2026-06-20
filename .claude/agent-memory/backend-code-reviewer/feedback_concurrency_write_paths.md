---
name: concurrency write-path checklist (exercise + anamnesis)
description: Deadlock/lock-ordering fixes reliably miss sibling write paths that touch the SAME locked rows; the lock only helps writers that ALL take it
type: feedback
---

Any concurrency fix (deterministic lock ordering, deadlock retry, $transaction hardening) must cover ALL functions that mutate the rows being locked, or the global lock-ordering invariant is broken and deadlocks remain reachable with no retry. "A global lock order is only as strong as its least-protected writer."

**exercise-service.js** — the 2026-06 round wrapped 7 tx with `withDeadlockRetry` + `lockTrainingForUpdate` and left `reorderSubstitutes`, `reorderSupersetMembers`, `dissolveSuperset` untouched (still `Promise.all` over updates). **Fixed in the follow-up 2026-06-20 round**: all 11 exercise-service tx now lock+retry+sequential-sorted updates. Verified complete.

**anamnesis-service.js / admin-anamnesis-service.js** — SAME mistake recurred in the 2026-06-20 round. `reorderSections` / `reorderPublicSections` were given `lockAnamnesisForUpdate` + retry, but the sibling writers on the SAME `anamnesisSection` rows were NOT:
- `anamnesis-service.js:296` (delete-anamnesis cascade), `:418` (`deleteSection`)
- `admin-anamnesis-service.js:176` (delete-public cascade), and the public `deleteSection` equivalent
These do `prisma.$transaction(async tx => { ... section writes ... })` with no `lockAnamnesisForUpdate` first statement and no `withDeadlockRetry`. A concurrent reorder + delete on the same anamnesis can still deadlock (reorder locks anamnesis-row then section-rows; delete locks section-rows directly → cycle), and the unwrapped delete throws an unretried 500 if chosen as victim. All gate on `assertAnamnesisNotLinked`, so they ARE concurrent trainer-edit ops — reachable.

**How to apply:** When reviewing a row-lock/retry fix, do NOT trust the PR's scope list. grep EVERY `$transaction` in the touched service (and admin variant) and confirm each one that writes the locked table either (1) calls the lock helper as FIRST statement + is `withDeadlockRetry`-wrapped, or (2) is provably safe because it only writes freshly-created rows (e.g. `training-service.importFromTemplate:335` creates a new training then writes its own new exercise rows — no shared-row contention, so no lock needed; BUT it is still unwrapped by retry, inconsistent with the AI-service policy that create-heavy cascades get retry). Use `grep -rn '[.]\$transaction' src/` (escape `$` or the shell eats it and you'll wrongly conclude "all wrapped").

**Retry safety of create-heavy cascades (AI service):** confirmed safe to retry — all reads are snapshots taken before the tx or inside it, all writes scoped to the tx, full rollback on 40P01 leaves no orphans. `withDeadlockRetry` alone (no row lock) is correct there since each create cascade has no shared parent row.

Also: `withDeadlockRetry`'s `maxRetries` is actually max *attempts* (off-by-one — `attempt >= maxRetries` throws on the Nth failure, giving N-1 retries). Tests enshrine this. The `invocationCallOrder` lock-ordering test technique is reliable (Vitest call-order is globally monotonic across mocks) but only asserts lock-before-FIRST-write, not before every write — acceptable since the lock is the literal first statement. See [[feedback_exercise_copy_flows]] for the analogous missed-copy-site pattern.
