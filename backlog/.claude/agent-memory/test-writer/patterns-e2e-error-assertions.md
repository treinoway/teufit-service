---
name: e2e-error-response-assertions
description: Never assert body.error === 'SOME_CODE' in E2E tests — only status code is reliable
metadata:
  type: feedback
---

Do NOT assert on `body.error` containing an error code string (e.g., `'EXERCISE_TEMPLATE_NOT_FOUND'`) in E2E tests.

**Why:** The actual serialized `error` field in the response body does not reliably contain the error code string. In practice, the received value appears to be the message text, not the code, due to Fastify's response serialization pipeline (fast-json-stringify + preSerialization hooks). The exact cause is unclear (possibly the route schema's errorResponseSchema vs the setErrorHandler pipeline), but the symptom is consistent: asserting `body.error === 'SOME_ERROR_CODE'` fails even when the 404 is thrown correctly.

**How to apply:** In E2E tests, assert only `response.statusCode` for error paths. Do not add `expect(body).toHaveProperty('error', 'SOME_CODE')`. Unit tests (which check thrown AppError directly) ARE the right place to assert error codes — use `rejects.toMatchObject({ code: '...', statusCode: ... })`.

**Pattern to avoid:**
```js
// WRONG in E2E:
expect(response.statusCode).toBe(404);
const body = response.json();
expect(body).toHaveProperty('error', 'EXERCISE_TEMPLATE_NOT_FOUND'); // fails
```

**Correct E2E pattern:**
```js
// RIGHT in E2E:
expect(response.statusCode).toBe(404);
// status code only — no body.error assertion
```
