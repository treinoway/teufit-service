import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

e2eDescribe('e2e: GET /trainers', () => {
  let app;

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

  async function createUserWithToken() {
    const email = `e2e+user-${Date.now()}@example.com`;
    const password = 'StrongPassw0rd!';

    const signupRes = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password },
    });
    expect(signupRes.statusCode).toBe(201);
    const { token: { accessToken } } = signupRes.json();

    return { accessToken, email };
  }

  async function createTrainerWithToken() {
    const { accessToken: userToken, email } = await createUserWithToken();

    const becomeRes = await app.inject({
      method: 'PATCH',
      url: '/become-trainer',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(becomeRes.statusCode).toBe(200);
    const { token: { accessToken } } = becomeRes.json();

    return { accessToken, email };
  }

  describe('authentication', () => {
    it('returns 401 when no token is provided', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/trainers',
      });

      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body).toHaveProperty('error');
      expect(body).toHaveProperty('messageCode');
      expect(body).toHaveProperty('message');
    });

    it('returns 200 when authenticated as a student (no role guard)', async () => {
      const { accessToken } = await createUserWithToken();

      const res = await app.inject({
        method: 'GET',
        url: '/trainers',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json())).toBe(true);
    });

    it('returns 200 when authenticated as a trainer', async () => {
      const { accessToken } = await createTrainerWithToken();

      const res = await app.inject({
        method: 'GET',
        url: '/trainers',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json())).toBe(true);
    });
  });

  describe('response shape', () => {
    it('returns an empty array when no active trainers exist', async () => {
      const { accessToken } = await createUserWithToken();

      const res = await app.inject({
        method: 'GET',
        url: '/trainers',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });

    it('returns active trainers with the correct public profile shape', async () => {
      const { accessToken: studentToken } = await createUserWithToken();
      await createTrainerWithToken();

      const res = await app.inject({
        method: 'GET',
        url: '/trainers',
        headers: { authorization: `Bearer ${studentToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.length).toBeGreaterThanOrEqual(1);

      const trainer = body[0];
      expect(trainer).toHaveProperty('id');
      expect(trainer).toHaveProperty('firstName');
      expect(trainer).toHaveProperty('lastName');
      expect(trainer).toHaveProperty('avatarUrl');
      expect(trainer).toHaveProperty('serviceMode');
      expect(trainer).toHaveProperty('address');
      expect(trainer).toHaveProperty('socialNetworks');
    });
  });
});
