import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import {
  createAdminWithToken,
  createTrainerWithToken,
  createStudentWithToken,
} from '../helpers/admin-users.js';
import { ROLLBAR_TEST_ERROR_MESSAGE } from '../../api/routes/admin-debug-route.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

e2eDescribe('e2e: admin debug (temporary Rollbar test route)', () => {
  let app;

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  function triggerTestError(accessToken) {
    return app.inject({
      method: 'POST',
      url: '/admin/debug/rollbar-test',
      headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
    });
  }

  it('returns 401 without a token', async () => {
    const response = await triggerTestError(null);

    expect(response.statusCode).toBe(401);
  });

  it('returns 403 auth.forbidden to a trainer', async () => {
    const { accessToken } = await createTrainerWithToken(app);

    const response = await triggerTestError(accessToken);

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'FORBIDDEN', messageCode: 'auth.forbidden' });
  });

  it('returns 403 to a student', async () => {
    const { accessToken } = await createStudentWithToken(app);

    const response = await triggerTestError(accessToken);

    expect(response.statusCode).toBe(403);
  });

  it('fails with the standard 500 contract for an admin without leaking the internal message', async () => {
    const { accessToken } = await createAdminWithToken(app);

    const response = await triggerTestError(accessToken);

    expect(response.statusCode).toBe(500);
    const body = response.json();
    expect(body).toMatchObject({
      error: 'INTERNAL_SERVER_ERROR',
      messageCode: 'internal.serverError',
      message: expect.any(String),
    });
    expect(body.message).not.toContain(ROLLBAR_TEST_ERROR_MESSAGE);
  });
});
