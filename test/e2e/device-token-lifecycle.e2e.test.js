import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { signupVerified } from '../helpers/signup-user.js';
import { prisma } from '../../src/db.js';
import { DEVICE_TOKEN_MAX_LENGTH } from '../../src/constants/mobile-app.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const PASSWORD = 'StrongPassw0rd!';
const NEW_PASSWORD = 'NewPassw0rd!';
const COACH_APP_ID = 'br.com.teufit.coach';
const PLATFORM_ANDROID = 'android';
const VALIDATION_ERROR = 'VALIDATION_ERROR';
const VALIDATION_MESSAGE_CODE = 'validation.failed';
const HTTP_NO_CONTENT = 204;

e2eDescribe('e2e: device token lifecycle', () => {
  let app;
  let emailCounter = 0;

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  async function createUser() {
    emailCounter += 1;
    const response = await signupVerified(app, {
      method: 'POST',
      url: '/auth/signup',
      payload: { email: `e2e+lifecycle-${Date.now()}-${emailCounter}@example.com`, password: PASSWORD },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    return { userId: body.user.id, accessToken: body.token.accessToken };
  }

  function registerDevice(accessToken, token) {
    return app.inject({
      method: 'POST',
      url: '/me/devices',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { token, platform: PLATFORM_ANDROID, appId: COACH_APP_ID },
    });
  }

  function removeDevice(accessToken, token) {
    return app.inject({
      method: 'DELETE',
      url: `/me/devices/${encodeURIComponent(token)}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  function tokenOfLength(length) {
    return 'a'.repeat(length);
  }

  describe('password change', () => {
    it('should delete the devices of the user and keep the devices of other users', async () => {
      const user = await createUser();
      const otherUser = await createUser();
      await registerDevice(user.accessToken, 'device-of-user-1');
      await registerDevice(user.accessToken, 'device-of-user-2');
      await registerDevice(otherUser.accessToken, 'device-of-other-user');

      const response = await app.inject({
        method: 'POST',
        url: '/auth/change-password',
        headers: { authorization: `Bearer ${user.accessToken}` },
        payload: {
          currentPassword: PASSWORD,
          newPassword: NEW_PASSWORD,
          newPasswordConfirmation: NEW_PASSWORD,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(await prisma.device.count({ where: { userId: user.userId } })).toBe(0);
      expect(await prisma.device.count({ where: { userId: otherUser.userId } })).toBe(1);
    });
  });

  describe('token length limit', () => {
    it('should round-trip a token of the maximum length through register and URL-encoded removal', async () => {
      const { accessToken } = await createUser();
      const token = tokenOfLength(DEVICE_TOKEN_MAX_LENGTH);

      const registered = await registerDevice(accessToken, token);
      const stored = await prisma.device.count({ where: { token } });
      const removed = await removeDevice(accessToken, token);

      expect(registered.statusCode).toBe(200);
      expect(stored).toBe(1);
      expect(removed.statusCode).toBe(HTTP_NO_CONTENT);
      expect(await prisma.device.count({ where: { token } })).toBe(0);
    });

    it('should reject registering a token above the maximum length with the validation error', async () => {
      const { accessToken } = await createUser();

      const response = await registerDevice(accessToken, tokenOfLength(DEVICE_TOKEN_MAX_LENGTH + 1));

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: VALIDATION_ERROR,
        messageCode: VALIDATION_MESSAGE_CODE,
      });
    });

    it('should answer 404 instead of 500 when removing a token above the maximum length', async () => {
      const { accessToken } = await createUser();

      const response = await removeDevice(accessToken, tokenOfLength(DEVICE_TOKEN_MAX_LENGTH + 1));

      expect(response.statusCode).toBe(404);
    });
  });
});
