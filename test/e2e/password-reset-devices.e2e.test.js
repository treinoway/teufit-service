import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { signupVerified } from '../helpers/signup-user.js';
import { prisma } from '../../src/db.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const PASSWORD = 'StrongPassw0rd!';
const NEW_PASSWORD = 'BrandNewPassw0rd!';
const COACH_APP_ID = 'br.com.teufit.coach';
const PLATFORM_ANDROID = 'android';
const HTTP_OK = 200;

e2eDescribe('e2e: password reset removes the user devices', () => {
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
    const email = `e2e+pwdev-${Date.now()}-${emailCounter}@example.com`;
    const response = await signupVerified(app, { payload: { email, password: PASSWORD } });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    return { email, userId: body.user.id, accessToken: body.token.accessToken };
  }

  async function registerDevice(accessToken, token) {
    const response = await app.inject({
      method: 'POST',
      url: '/me/devices',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { token, platform: PLATFORM_ANDROID, appId: COACH_APP_ID },
    });
    expect(response.statusCode).toBe(HTTP_OK);
  }

  async function resetPassword(email) {
    const forgot = await app.inject({ method: 'POST', url: '/auth/forgot-password', payload: { email } });
    expect(forgot.statusCode).toBe(HTTP_OK);
    return app.inject({
      method: 'POST',
      url: '/auth/reset-password',
      payload: { email, code: forgot.json().resetToken, password: NEW_PASSWORD, passwordConfirmation: NEW_PASSWORD },
    });
  }

  it('should delete the devices of the user that reset the password and keep other users devices', async () => {
    const resetting = await createUser();
    const other = await createUser();
    await registerDevice(resetting.accessToken, 'token-resetting-1');
    await registerDevice(resetting.accessToken, 'token-resetting-2');
    await registerDevice(other.accessToken, 'token-other');

    const response = await resetPassword(resetting.email);

    expect(response.statusCode).toBe(HTTP_OK);
    expect(await prisma.device.findMany({ where: { userId: resetting.userId } })).toHaveLength(0);
    expect(await prisma.device.findUnique({ where: { token: 'token-other' } })).toMatchObject({ userId: other.userId });
  });

  it('should keep the devices when the reset code is wrong', async () => {
    const user = await createUser();
    await registerDevice(user.accessToken, 'token-kept');
    await app.inject({ method: 'POST', url: '/auth/forgot-password', payload: { email: user.email } });

    const response = await app.inject({
      method: 'POST',
      url: '/auth/reset-password',
      payload: { email: user.email, code: '000000', password: NEW_PASSWORD, passwordConfirmation: NEW_PASSWORD },
    });

    expect(response.statusCode).toBe(400);
    expect(await prisma.device.findMany({ where: { userId: user.userId } })).toHaveLength(1);
  });
});
