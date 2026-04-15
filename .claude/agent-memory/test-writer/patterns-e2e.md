---
name: E2E test patterns
description: App bootstrap, auth helpers, and TrainerStudent setup patterns used across E2E tests
type: feedback
---

## App bootstrap

All E2E test files follow this pattern:

```js
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

e2eDescribe('e2e: ...', () => {
  let app;
  beforeAll(async () => { app = await setupApp(); });
  afterAll(async () => { if (app) await app.close(); });
  beforeEach(async () => { await cleanDatabase(); });
});
```

## Creating a linked trainer-student pair in E2E

To test `hasActiveTrainer: true`, create a trainer via `/become-trainer` and link the student via `POST /trainer/students`:

```js
async function createTrainerAndLinkStudent(app, studentEmail) {
  // 1. Signup a trainer user
  const signupRes = await app.inject({ method: 'POST', url: '/auth/signup', payload: { email, password } });
  const { token: { accessToken: rawToken } } = signupRes.json();

  // 2. Become trainer (returns new token)
  const becomeRes = await app.inject({ method: 'PATCH', url: '/become-trainer', headers: { authorization: `Bearer ${rawToken}` } });
  const { token: { accessToken: trainerToken } } = becomeRes.json();

  // 3. Link student by email
  await app.inject({ method: 'POST', url: '/trainer/students', headers: { authorization: `Bearer ${trainerToken}` }, payload: { email: studentEmail } });
}
```

Note: `/become-trainer` returns a **new** accessToken — always use the token from the `PATCH /become-trainer` response for subsequent trainer calls, not the signup token.

## Auth helper pattern

Use unique email suffixes with `Date.now()` to avoid conflicts across parallel test runs:

```js
const email = `e2e+<feature>-<role>-${Date.now()}@example.com`;
```
