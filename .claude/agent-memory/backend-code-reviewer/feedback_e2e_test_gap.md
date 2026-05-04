---
name: backend-engineer skips E2E tests
description: backend-engineer reports "all tests pass" while only adding unit tests — E2E coverage is routinely missing
type: feedback
---

When backend-engineer reports test counts ("1733 tests passing"), this is usually unit-only. E2E coverage for the new feature is frequently absent.

**Why:** Unit tests mock Prisma and miss integration/propagation defects (junction → exercise copy bugs, schema drift, real validation flow). The treinoway-service CLAUDE.md explicitly mandates "E2E tests for API endpoints" for every new feature.

**How to apply:** Whenever a PR adds a new request/response field or new endpoint, grep `test/e2e/` for the field/endpoint. If absent, flag as a blocking gap regardless of unit test count. Always check `test/services/training-protocol-service.test.js`, `training-service.test.js`, and any `ai-training-service.*.test.js` for cross-cutting field propagation tests, since these flows are the most accident-prone.
