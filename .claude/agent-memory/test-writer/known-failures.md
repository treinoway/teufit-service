---
name: Pre-existing E2E failures
description: E2E test files with known pre-existing failures not related to user-service work
type: project
---

As of 2026-04-14, the following E2E test failures are pre-existing and not caused by user-service changes:

- `test/e2e/admin-anamnesis.e2e.test.js` — 1 failure (PATCH anamnesis linked to student)
- `test/e2e/ai.e2e.test.js` — 1 failure (multi-turn tool_result persistence)
- `test/e2e/anamnesis.e2e.test.js` — 1 failure (numeric question config creation)
- `test/e2e/auth.e2e.test.js` — 2 failures (INVALID_CREDENTIALS messageCode assertions)
- `test/e2e/import-primecoaching.e2e.test.js` — 3 failures (mock/format issues)

**Root cause pattern for all-tests-in-file failing:** When ALL tests in an E2E file fail with `relation "anamnesis_answers" does not exist` in `cleanDatabase` (beforeEach), the local Postgres container is not migrated. This is an infrastructure issue — `npm run db:migrate` needs to be run. The tests themselves are correct.

**Why:** These are tracked separately. Do not treat them as regressions when writing or running tests for unrelated features.

Total pre-existing: 8 failures across 5 files (environment-level failures across whole files don't count as test-logic failures).
