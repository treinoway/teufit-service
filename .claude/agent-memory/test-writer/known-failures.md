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

- `test/e2e/training-template.e2e.test.js` — 4 failures in `POST /trainer/trainings/from-template` section. All use `createProtocol(accessToken, assigneeId)` which calls `/trainer/protocols`. That endpoint calls `assertStudentActiveOnPlan()` (added in commit `94710ca`), but the `createAssigneeWithToken` helper never sets up a TrainerStudent link. Tests were written in commit `d5af540` before the plan guard existed. Fix requires adding a `createTrainerStudentLink` setup step in those tests.

Total pre-existing: 21 failures across 7 files.

**E2E first-run flakiness:** `workout-session.e2e.test.js` can report 56 failures on the very first cold run (all showing signup → 500 errors). Re-running immediately produces 92/92 passes. Root cause is likely a cold DB or cleanDatabase timing issue on startup. Do NOT treat the first run as ground truth — re-run before diagnosing.
