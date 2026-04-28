import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { prisma } from '../../src/db.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const BOOTSTRAP_EMAIL = 'n.santos1897@gmail.com';

e2eDescribe('e2e: POST /me/grant-admin (bootstrap)', () => {
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

  async function signupAndLogin(email) {
    const password = 'StrongPassw0rd!';
    const signup = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password },
    });
    expect(signup.statusCode).toBe(201);
    return {
      userId: signup.json().user.id,
      accessToken: signup.json().token.accessToken,
    };
  }

  it('grants admin role to allowlisted email and rotates tokens', async () => {
    const { userId, accessToken } = await signupAndLogin(BOOTSTRAP_EMAIL);

    const response = await app.inject({
      method: 'POST',
      url: '/me/grant-admin',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.user.roles).toContain('admin');
    expect(body.token.accessToken).toBeTypeOf('string');
    expect(body.token.accessToken).not.toBe(accessToken);
    expect(body.refreshToken).toBeTypeOf('string');

    const persisted = await prisma.user.findUnique({ where: { id: userId }, select: { roles: true } });
    expect(persisted.roles).toContain('admin');

    const adminGet = await app.inject({
      method: 'GET',
      url: '/admin/videos',
      headers: { authorization: `Bearer ${body.token.accessToken}` },
    });
    expect(adminGet.statusCode).toBe(200);
  });

  it('is idempotent — second call still returns 200 with admin role', async () => {
    const { accessToken } = await signupAndLogin(BOOTSTRAP_EMAIL);
    const first = await app.inject({
      method: 'POST',
      url: '/me/grant-admin',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: '/me/grant-admin',
      headers: { authorization: `Bearer ${first.json().token.accessToken}` },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().user.roles).toContain('admin');
  });

  it('returns 403 when email is not on the allowlist', async () => {
    const { accessToken } = await signupAndLogin(`other-${Date.now()}@example.com`);
    const response = await app.inject({
      method: 'POST',
      url: '/me/grant-admin',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().messageCode).toBe('admin.grantNotAllowed');
  });

  it('returns 401 without auth', async () => {
    const response = await app.inject({ method: 'POST', url: '/me/grant-admin' });
    expect(response.statusCode).toBe(401);
  });
});
