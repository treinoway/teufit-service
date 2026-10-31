import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { signupVerified } from '../helpers/signup-user.js';
import { prisma } from '../../src/db.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const PASSWORD = 'StrongPassw0rd!';
const FCM_TOKEN = 'fcm-token-device-e2e';
const COACH_APP_ID = 'br.com.teufit.coach';
const PLATFORM_IOS = 'ios';
const PLATFORM_ANDROID = 'android';
const VALIDATION_ERROR = 'VALIDATION_ERROR';
const VALIDATION_MESSAGE_CODE = 'validation.failed';
const HTTP_NO_CONTENT = 204;

e2eDescribe('e2e: /me/devices', () => {
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
      payload: { email: `e2e+device-${Date.now()}-${emailCounter}@example.com`, password: PASSWORD },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    return { userId: body.user.id, accessToken: body.token.accessToken };
  }

  function registerDevice(accessToken, payload) {
    return app.inject({
      method: 'POST',
      url: '/me/devices',
      headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
      payload,
    });
  }

  function removeDevice(accessToken, token) {
    return app.inject({
      method: 'DELETE',
      url: `/me/devices/${token}`,
      headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
    });
  }

  function validPayload(overrides = {}) {
    return { token: FCM_TOKEN, platform: PLATFORM_IOS, appId: COACH_APP_ID, ...overrides };
  }

  describe('POST /me/devices', () => {
    it('should return 401 without a bearer token', async () => {
      const response = await registerDevice(null, validPayload());

      expect(response.statusCode).toBe(401);
    });

    it('should register the token for the authenticated user', async () => {
      const { userId, accessToken } = await createUser();

      const response = await registerDevice(accessToken, validPayload());

      expect(response.statusCode).toBe(200);
      const stored = await prisma.device.findUnique({ where: { token: FCM_TOKEN } });
      expect(stored).toMatchObject({ userId, platform: PLATFORM_IOS, appId: COACH_APP_ID });
    });

    it('should not duplicate the device when the same token is registered twice', async () => {
      const { accessToken } = await createUser();

      const first = await registerDevice(accessToken, validPayload());
      const second = await registerDevice(accessToken, validPayload());

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(await prisma.device.count({ where: { token: FCM_TOKEN } })).toBe(1);
    });

    it('should move the token to the new owner when another user registers it', async () => {
      const previousOwner = await createUser();
      const newOwner = await createUser();
      await registerDevice(previousOwner.accessToken, validPayload());

      const response = await registerDevice(newOwner.accessToken, validPayload());

      expect(response.statusCode).toBe(200);
      const stored = await prisma.device.findMany({ where: { token: FCM_TOKEN } });
      expect(stored).toHaveLength(1);
      expect(stored[0].userId).toBe(newOwner.userId);
    });

    it('should update platform and appId when the same token is registered again', async () => {
      const { accessToken } = await createUser();
      await registerDevice(accessToken, validPayload());

      await registerDevice(accessToken, validPayload({ platform: PLATFORM_ANDROID }));

      const stored = await prisma.device.findUnique({ where: { token: FCM_TOKEN } });
      expect(stored.platform).toBe(PLATFORM_ANDROID);
    });

    it('should reject a platform outside ios and android with the validation error contract', async () => {
      const { accessToken } = await createUser();

      const response = await registerDevice(accessToken, validPayload({ platform: 'windows' }));

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: VALIDATION_ERROR,
        messageCode: VALIDATION_MESSAGE_CODE,
      });
    });

    it('should reject a missing token with the validation error contract', async () => {
      const { accessToken } = await createUser();

      const response = await registerDevice(accessToken, { platform: PLATFORM_IOS, appId: COACH_APP_ID });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe(VALIDATION_ERROR);
    });

    it('should reject a missing appId with the validation error contract', async () => {
      const { accessToken } = await createUser();

      const response = await registerDevice(accessToken, { token: FCM_TOKEN, platform: PLATFORM_IOS });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe(VALIDATION_ERROR);
    });
  });

  describe('DELETE /me/devices/:token', () => {
    it('should return 401 without a bearer token', async () => {
      const response = await removeDevice(null, FCM_TOKEN);

      expect(response.statusCode).toBe(401);
    });

    it('should remove the token of the authenticated user', async () => {
      const { accessToken } = await createUser();
      await registerDevice(accessToken, validPayload());

      const response = await removeDevice(accessToken, FCM_TOKEN);

      expect(response.statusCode).toBe(HTTP_NO_CONTENT);
      expect(await prisma.device.count({ where: { token: FCM_TOKEN } })).toBe(0);
    });

    it('should keep the token when another user tries to remove it', async () => {
      const owner = await createUser();
      const intruder = await createUser();
      await registerDevice(owner.accessToken, validPayload());

      await removeDevice(intruder.accessToken, FCM_TOKEN);

      expect(await prisma.device.count({ where: { token: FCM_TOKEN } })).toBe(1);
    });

    it('should answer 204 when the token is not registered', async () => {
      const { accessToken } = await createUser();

      const response = await removeDevice(accessToken, 'unknown-token');

      expect(response.statusCode).toBe(HTTP_NO_CONTENT);
    });
  });
});
