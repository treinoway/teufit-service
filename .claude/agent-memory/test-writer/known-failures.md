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

Total pre-existing: 17 failures across 6 files.
