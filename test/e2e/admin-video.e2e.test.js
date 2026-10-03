import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { prisma } from '../../src/db.js';
import { Roles } from '../../src/constants/roles.js';
import { signupVerified } from '../helpers/signup-user.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

e2eDescribe('e2e: admin video library', () => {
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

  async function createUserAndGetId(email, password = 'StrongPassw0rd!') {
    const response = await signupVerified(app, {
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password },
    });
    expect(response.statusCode).toBe(201);
    return response.json().user.id;
  }

  async function createAdminWithToken() {
    const email = `e2e+admin-${Date.now()}-${Math.random()}@example.com`;
    const userId = await createUserAndGetId(email);
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { roles: [Roles.ADMIN] },
    });
    const accessToken = app.jwt.sign({
      sub: updatedUser.id,
      email: updatedUser.email,
      roles: [Roles.ADMIN],
      status: updatedUser.status,
    });
    return { userId, accessToken };
  }

  async function createTrainerWithToken() {
    const email = `e2e+trainer-${Date.now()}-${Math.random()}@example.com`;
    const password = 'StrongPassw0rd!';
    const signupResponse = await signupVerified(app, {
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password },
    });
    expect(signupResponse.statusCode).toBe(201);
    const { user: { id: userId }, token: { accessToken } } = signupResponse.json();
    const becomeTrainerResponse = await app.inject({
      method: 'PATCH',
      url: '/become-trainer',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(becomeTrainerResponse.statusCode).toBe(200);
    const { token: { accessToken: trainerToken } } = becomeTrainerResponse.json();
    return { userId, accessToken: trainerToken };
  }

  function payload(overrides = {}) {
    return {
      title: 'Push Up - Standard',
      description: 'Standard form push up',
      url: 'https://www.youtube.com/watch?v=IODxDxX7oi4',
      thumbnailUrl: 'https://img.youtube.com/vi/IODxDxX7oi4/0.jpg',
      duration: 75,
      category: 'strength',
      bodySegment: 'upper',
      tags: ['push', 'chest', 'beginner'],
      ...overrides,
    };
  }

  describe('POST /admin/videos', () => {
    it('admin creates a video', async () => {
      const { accessToken } = await createAdminWithToken();
      const response = await app.inject({
        method: 'POST',
        url: '/admin/videos',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'app-language': 'en-US',
        },
        payload: payload(),
      });
      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body).toMatchObject({
        id: expect.any(String),
        title: 'Push Up - Standard',
        category: 'strength',
        bodySegment: 'upper',
        tags: ['push', 'chest', 'beginner'],
      });
      expect(body.categoryLabel).toBe('Strength');
      expect(body.bodySegmentLabel).toBe('Upper');
    });

    it('returns 400 when url is invalid', async () => {
      const { accessToken } = await createAdminWithToken();
      const response = await app.inject({
        method: 'POST',
        url: '/admin/videos',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: payload({ url: 'not-a-url' }),
      });
      expect(response.statusCode).toBe(400);
    });

    it('returns 400 when category is unknown', async () => {
      const { accessToken } = await createAdminWithToken();
      const response = await app.inject({
        method: 'POST',
        url: '/admin/videos',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: payload({ category: 'unknown' }),
      });
      expect(response.statusCode).toBe(400);
    });

    it('returns 403 to a trainer', async () => {
      const { accessToken } = await createTrainerWithToken();
      const response = await app.inject({
        method: 'POST',
        url: '/admin/videos',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: payload(),
      });
      expect(response.statusCode).toBe(403);
    });

    it('returns 401 without auth', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/admin/videos',
        payload: payload(),
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /admin/videos', () => {
    it('paginates and filters by category', async () => {
      const { accessToken } = await createAdminWithToken();
      const r1 = await app.inject({
        method: 'POST', url: '/admin/videos',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: payload({ title: 'A', category: 'strength' }),
      });
      expect(r1.statusCode).toBe(201);
      const fullPayload = payload();
      delete fullPayload.bodySegment;
      const withoutBodySegment = fullPayload;
      const r2 = await app.inject({
        method: 'POST', url: '/admin/videos',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { ...withoutBodySegment, title: 'B', category: 'cardio' },
      });
      expect(r2.statusCode).toBe(201);

      const list = await app.inject({
        method: 'GET',
        url: '/admin/videos?category=cardio',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(list.statusCode).toBe(200);
      const body = list.json();
      expect(body.total).toBe(1);
      expect(body.items[0].category).toBe('cardio');
    });

    it('search matches title insensitively', async () => {
      const { accessToken } = await createAdminWithToken();
      await app.inject({
        method: 'POST', url: '/admin/videos',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: payload({ title: 'Bench Press' }),
      });

      const list = await app.inject({
        method: 'GET',
        url: '/admin/videos?search=bench',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(list.statusCode).toBe(200);
      expect(list.json().total).toBe(1);
    });
  });

  describe('PATCH /admin/videos/:videoId', () => {
    it('updates partial fields', async () => {
      const { accessToken } = await createAdminWithToken();
      const created = await app.inject({
        method: 'POST', url: '/admin/videos',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: payload(),
      });
      const id = created.json().id;

      const updated = await app.inject({
        method: 'PATCH',
        url: `/admin/videos/${id}`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { title: 'New title', tags: ['UPPER'] },
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json().title).toBe('New title');
      expect(updated.json().tags).toEqual(['upper']);
    });

    it('returns 404 for unknown id', async () => {
      const { accessToken } = await createAdminWithToken();
      const response = await app.inject({
        method: 'PATCH',
        url: `/admin/videos/00000000-0000-0000-0000-000000000000`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { title: 'X' },
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('DELETE /admin/videos/:videoId', () => {
    it('soft-deletes a video', async () => {
      const { accessToken } = await createAdminWithToken();
      const created = await app.inject({
        method: 'POST', url: '/admin/videos',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: payload(),
      });
      const id = created.json().id;

      const del = await app.inject({
        method: 'DELETE',
        url: `/admin/videos/${id}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(del.statusCode).toBe(200);

      const after = await app.inject({
        method: 'GET',
        url: `/admin/videos/${id}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(after.statusCode).toBe(404);
    });
  });
});
