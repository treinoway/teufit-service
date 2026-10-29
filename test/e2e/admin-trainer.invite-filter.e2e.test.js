import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { createAdminWithToken, createTrainerWithToken } from '../helpers/admin-users.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;
const OK_STATUS = 200;

e2eDescribe('e2e: GET /admin/trainers inviteStatus=pending without pending invites', () => {
  let app;
  let adminToken;

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
    ({ accessToken: adminToken } = await createAdminWithToken(app));
  });

  it('should return total 0 and no items', async () => {
    await createTrainerWithToken(app);

    const response = await app.inject({
      method: 'GET',
      url: '/admin/trainers?includeSignups=true&inviteStatus=pending',
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(response.statusCode).toBe(OK_STATUS);
    expect(response.json()).toMatchObject({ items: [], total: 0 });
  });
});
