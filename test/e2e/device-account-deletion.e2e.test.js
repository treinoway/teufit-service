import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { signupVerified } from '../helpers/signup-user.js';
import { prisma } from '../../src/db.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const PASSWORD = 'StrongPassw0rd!';
const COACH_APP_ID = 'br.com.teufit.coach';
const PLATFORM_ANDROID = 'android';
const HTTP_NO_CONTENT = 204;
const LONG_TOKEN = `${'a1B2c3D4e5:'.repeat(8)}APA91b-${'x-Y_z'.repeat(15)}`;

e2eDescribe('e2e: device cleanup and long tokens', () => {
  let app;
  let emailCounter = 0;

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  async function createUser() {
    emailCounter += 1;
    const response = await signupVerified(app, {
      method: 'POST',
      url: '/auth/signup',
      payload: { email: `e2e+devdel-${Date.now()}-${emailCounter}@example.com`, password: PASSWORD },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    return { userId: body.user.id, accessToken: body.token.accessToken };
  }

  function authHeaders(accessToken) {
    return { authorization: `Bearer ${accessToken}` };
  }

  function registerDevice(accessToken, token) {
    return app.inject({
      method: 'POST',
      url: '/me/devices',
      headers: authHeaders(accessToken),
      payload: { token, platform: PLATFORM_ANDROID, appId: COACH_APP_ID },
    });
  }

  describe('DELETE /me', () => {
    it('should remove the deleted user devices and leave other users devices untouched', async () => {
      const deleted = await createUser();
      const other = await createUser();
      expect((await registerDevice(deleted.accessToken, 'token-deleted-user')).statusCode).toBe(200);
      expect((await registerDevice(other.accessToken, 'token-other-user')).statusCode).toBe(200);

      const response = await app.inject({ method: 'DELETE', url: '/me', headers: authHeaders(deleted.accessToken) });

      expect(response.statusCode).toBe(HTTP_NO_CONTENT);
      expect(await prisma.device.findMany({ where: { userId: deleted.userId } })).toHaveLength(0);
      expect(await prisma.device.findUnique({ where: { token: 'token-other-user' } })).toMatchObject({
        userId: other.userId,
      });
    });
  });

  describe('long device token', () => {
    it('should round-trip a long URL-encoded token through POST then DELETE /me/devices/:token', async () => {
      const { userId, accessToken } = await createUser();
      expect(LONG_TOKEN.length).toBeGreaterThanOrEqual(170);

      const created = await registerDevice(accessToken, LONG_TOKEN);
      expect(created.statusCode).toBe(200);
      expect(await prisma.device.findUnique({ where: { token: LONG_TOKEN } })).toMatchObject({ userId });

      const removed = await app.inject({
        method: 'DELETE',
        url: `/me/devices/${encodeURIComponent(LONG_TOKEN)}`,
        headers: authHeaders(accessToken),
      });

      expect(removed.statusCode).toBe(HTTP_NO_CONTENT);
      expect(await prisma.device.findUnique({ where: { token: LONG_TOKEN } })).toBeNull();
    });
  });
});
