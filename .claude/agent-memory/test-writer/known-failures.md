---
name: Pre-existing E2E failures
description: E2E test files with known pre-existing failures not related to user-service work
type: project
---

As of 2026-05-02 (staging branch), the following E2E test failures are pre-existing and not caused by test-writer changes:

- `test/e2e/admin-anamnesis.e2e.test.js` — 1 failure (PATCH anamnesis linked to student)
- `test/e2e/ai.e2e.test.js` — 1 failure (multi-turn tool_result persistence — `getConversation` API does not expose `rawContent` or `tool_result` role messages)
- `test/e2e/anamnesis.e2e.test.js` — 1 failure (numeric question config creation)
- `test/e2e/auth.e2e.test.js` — 2 failures (INVALID_CREDENTIALS messageCode assertions)
- `test/e2e/import-primecoaching.e2e.test.js` — 3 failures (mock/format issues)
- `test/e2e/nutritionist-patient.e2e.test.js` — 9 failures (caused by prescription_mode schema changes in staging branch, not by test logic)

**Key discovery:** `getConversation` service (ai-training-service.js) excludes `role: 'tool_result'` messages from its query and does not include `rawContent` in the select. E2E tests checking these fields will always fail. Only assert on `actionsExecuted` from the chat response or message count/role from the GET conversation response.

**Root cause pattern for all-tests-in-file failing:** When ALL tests in an E2E file fail with `relation "anamnesis_answers" does not exist` in `cleanDatabase` (beforeEach), the local Postgres container is not migrated. This is an infrastructure issue — `npm run db:migrate` needs to be run. The tests themselves are correct.

**Why:** These are tracked separately. Do not treat them as regressions when writing or running tests for unrelated features.

- `test/e2e/training-template.e2e.test.js` — 6 failures in `POST /trainer/trainings/from-template` and `PATCH ...exercises` sections. All use `createProtocol(accessToken, assigneeId)` which calls `/trainer/protocols`. That endpoint calls `assertStudentActiveOnPlan()` (added in commit `94710ca`), but the `createAssigneeWithToken` helper never sets up a TrainerStudent link. Fix requires adding a `createTrainerStudentLink` setup step in those tests.
- `test/e2e/training-protocol-template.e2e.test.js` — 2 failures in `POST /trainer/protocols/import-from-template (with trainings)` section. Same root cause: `assertStudentActiveOnPlan()` guard rejects because no TrainerStudent link is set up for the assignee.

Total pre-existing (as of 2026-05-02): 23 failures across 8 files.

**Note on paginated GET /trainer/protocol-templates:** As of 2026-06-17 (staging branch), the GET list for protocol templates was changed to return `{ data, total, page, limit }` instead of a plain array. Updated pre-existing i18n tests (which destructured from old array shape with `const [item] = response.json()`) to use `response.json().data` instead.

**E2E first-run flakiness:** `workout-session.e2e.test.js` can report 56 failures on the very first cold run (all showing signup → 500 errors). Re-running immediately produces 92/92 passes. Root cause is likely a cold DB or cleanDatabase timing issue on startup. Do NOT treat the first run as ground truth — re-run before diagnosing.

**2026-07-14 — INITIAL (WRONG) diagnosis, corrected 2026-07-15, see below.** An earlier pass through this file claimed `challenge.e2e.test.js`'s 28/36 failures (`expected 403 to be 201/200/400`) were "a real regression somewhere in the challenge creation path." **That conclusion was wrong** — it was reached from the status code alone, without reading the response body. The actual body was `{"error":"CHAMPIONSHIPS_NOT_AVAILABLE","messageCode":"platformPlan.championshipsNotAvailable", ...}` — an intentional, working plan gate. **Lesson: always read the error response body (`error` / `messageCode`) before classifying a non-2xx status as a regression. A 403 with a `platformPlan.*` messageCode is a feature working as designed, not a bug.**

**Corrected root cause (2026-07-15, staging branch):** commit `94710ca` ("Add trainer plan", 2026-05-17) added per-trainer plan gates (`src/services/platform-plan-service.js`) enforced from `challenge-service.js`, `trainer-branding-service.js`, `ai-training-service.js`, `anamnesis-service.js`, `training-protocol-service.js`, `student-subscription-service.js`, `trainer-service.js`, `asaas-subscription-service.js`, `asaas-webhook-service.js`. Trainers created via the standard E2E flow (`POST /auth/signup` → `PATCH /become-trainer`) get **no** `PlatformSubscription` row, so `getTrainerPlan()` defaults them to **FREE** (`studentCap: 3, aiActionsPerStudent: 0, aiActionsTrainerCap: 0, branding: false, championships: false` — see `src/constants/platform-plan.js`). Tests written before plan gates existed assumed unlimited trainer capability and started failing with 403 `platformPlan.*` errors once the gate shipped. This is a **fixture gap, not a production bug** — do not "fix" it by touching `src/`/`api/`.

**Fix:** added `test/helpers/platform-plan.js` exporting `provisionTrainerPlan(trainerId, tier = 'DIAMOND')`, which upserts a `PlatformSubscription` row (DIAMOND unlocks every gate: unlimited students/AI, branding, championships). Wired it into the local `createTrainerWithToken()` helper (call right after resolving `trainer.id` from `userId`, before returning) in the 3 files where isolated re-runs proved *every* failure was a `platformPlan.*` 403/cascade:
- `test/e2e/challenge.e2e.test.js` — 28/36 → 36/36 passing.
- `test/e2e/trainer-branding.e2e.test.js` — 10/22 → 22/22 passing.
- `test/e2e/ai.e2e.test.js` — 13/23 fixed → 22/23 passing; the 1 remaining failure (`multi-turn conversation persistence ... tool_result and rawContent`) is the pre-existing `getConversation` gap documented above, untouched.

Do **not** blanket-apply `provisionTrainerPlan` to every E2E file — most `createTrainerWithToken()` helpers were never plan-gated in the first place, and `platform-plan.e2e.test.js` specifically exercises FREE-tier gate behavior on purpose (it upserts its own tier per-test via `prisma.platformSubscription.upsert`). Only touch a file after confirming empirically (isolated run + reading response bodies) that its failures are `platformPlan.*` gate cascades.

**Files checked and confirmed NOT plan-related (left untouched) as of 2026-07-15:**
- `test/e2e/admin-anamnesis.e2e.test.js` — still exactly 1 failure, the pre-existing PATCH-linked-to-student 409 gap from the 2026-05-02 baseline. Not new.
- `test/e2e/nutritionist-patient.e2e.test.js` — 11 failures, all `400` on `/nutritionist/patients` and cascades. `nutritionist-patient-service.js` does not import `platform-plan-service.js` at all — these are the pre-existing `prescription_mode` schema-drift gap (grew from the documented 9 to 11, still same root cause, no plan-gate 403s observed).
- `test/e2e/training-protocol.e2e.test.js` — 13 failures, all cascades from the pre-existing `assertStudentActiveOnPlan()` / missing-`TrainerStudent`-link gap (same pattern already documented above for `training-template.e2e.test.js` and `training-protocol-template.e2e.test.js`). `createAssigneeWithToken()` never calls `POST /trainer/students`, so no `TrainerStudent` row exists and `assertStudentActiveOnPlan` rejects (surfaces as 500/400 depending on call site, not a clean 403 — worth a closer look if this file is ever put in scope, but the root cause is the missing link, not the trainer's tier).
- `test/e2e/health.e2e.test.js` — 2 failures, unchanged `vi.spyOn() can only spy on a function. Received undefined.` — real test/code drift unrelated to plans.
- `test/e2e/asaas-webhook.e2e.test.js` — 2 failures, but NOT plan-tier related: `webhook secret validation` expects 401 for a wrong/missing `asaas-access-token` header and gets 200 instead. This file already provisions its own `PlatformSubscription` per test (`createTrainerWithSubscription(tier, overrides)`). Looks like a genuine auth-validation regression in the webhook route — flagged for backend-engineer, out of scope for this fixture pass.
- `test/e2e/platform-plan.e2e.test.js` — 1 failure: `POST /trainer/platform-plan/checkout` returns 500 instead of 200 for a valid PRO/PIX checkout. Not a tier-default issue (test already calls the checkout endpoint to *upgrade* a FREE trainer) — looks like a genuine bug in the checkout flow, flagged for backend-engineer, out of scope for this fixture pass.

**When you hit a wall of E2E failures unrelated to your feature:** confirm via `git status` that you haven't touched any implementation file, then re-run 1-2 of the failing files in complete isolation (`vitest run test/e2e/<file>.test.js` alone, nothing else) and **read the response body**, not just the status code, before deciding whether it's a regression, a plan-gate cascade, or an unrelated pre-existing gap. Do not assume "first run flakiness" without isolating first. **Never run the full `test/e2e/` directory in one `vitest run` to establish a baseline** — 34 files sharing one Postgres connection pool produces spurious `Error: Connection terminated unexpectedly` failures (observed ~171 failures full-suite vs. clean per-file runs); per-file isolation is the only reliable signal.
**OUTDATED as of 2026-09-28 — see [[patterns-e2e]] "E2E harness is now Testcontainers-based".** `npm run test:e2e` no longer touches the shared dev Postgres container at all; `vitest.e2e.config.js` + `test/e2e/global-setup.js` spin up an ephemeral Testcontainers Postgres. Do NOT use the old `DATABASE_URL=... npx vitest run test/e2e/<file>.test.js` workaround — it now fails with "No test files found" because the default `vitest.config.js` excludes `test/e2e/**`. Use `npx vitest run --config vitest.e2e.config.js test/e2e/<file>.test.js` instead (no manual env vars needed).
