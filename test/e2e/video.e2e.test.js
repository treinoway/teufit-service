import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { prisma } from '../../src/db.js';
import { Roles } from '../../src/constants/roles.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

e2eDescribe('e2e: video library (trainer-facing)', () => {
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
    const response = await app.inject({
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
    const signupResponse = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password },
    });
    expect(signupResponse.statusCode).toBe(201);
    const { token: { accessToken } } = signupResponse.json();
    const becomeTrainerResponse = await app.inject({
      method: 'PATCH',
      url: '/become-trainer',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(becomeTrainerResponse.statusCode).toBe(200);
    const { token: { accessToken: trainerToken } } = becomeTrainerResponse.json();
    return { accessToken: trainerToken };
  }

  async function seedVideo(adminToken, overrides = {}) {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/videos',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        title: 'Push Up',
        url: 'https://www.youtube.com/watch?v=IODxDxX7oi4',
        category: 'strength',
        bodySegment: 'upper',
        tags: ['push'],
        ...overrides,
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json();
  }

  describe('GET /videos', () => {
    it('trainer lists videos', async () => {
      const { accessToken: adminToken } = await createAdminWithToken();
      await seedVideo(adminToken, { title: 'Squat', category: 'strength' });

      const { accessToken: trainerToken } = await createTrainerWithToken();
      const list = await app.inject({
        method: 'GET',
        url: '/videos',
        headers: { authorization: `Bearer ${trainerToken}` },
      });
      expect(list.statusCode).toBe(200);
      expect(list.json().total).toBe(1);
      expect(list.json().items[0].title).toBe('Squat');
    });

    it('does not return soft-deleted videos', async () => {
      const { accessToken: adminToken } = await createAdminWithToken();
      const created = await seedVideo(adminToken);
      await app.inject({
        method: 'DELETE',
        url: `/admin/videos/${created.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      const { accessToken: trainerToken } = await createTrainerWithToken();
      const list = await app.inject({
        method: 'GET',
        url: '/videos',
        headers: { authorization: `Bearer ${trainerToken}` },
      });
      expect(list.statusCode).toBe(200);
      expect(list.json().total).toBe(0);
    });

    it('filters by tag (case-insensitive normalization)', async () => {
      const { accessToken: adminToken } = await createAdminWithToken();
      await seedVideo(adminToken, { title: 'A', tags: ['Chest', 'Push'] });
      await seedVideo(adminToken, { title: 'B', tags: ['legs'] });

      const { accessToken: trainerToken } = await createTrainerWithToken();
      const list = await app.inject({
        method: 'GET',
        url: '/videos?tag=CHEST',
        headers: { authorization: `Bearer ${trainerToken}` },
      });
      expect(list.statusCode).toBe(200);
      expect(list.json().total).toBe(1);
      expect(list.json().items[0].title).toBe('A');
    });

    it('returns 401 without auth', async () => {
      const response = await app.inject({ method: 'GET', url: '/videos' });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /videos/:videoId', () => {
    it('trainer reads a single video', async () => {
      const { accessToken: adminToken } = await createAdminWithToken();
      const created = await seedVideo(adminToken);

      const { accessToken: trainerToken } = await createTrainerWithToken();
      const get = await app.inject({
        method: 'GET',
        url: `/videos/${created.id}`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });
      expect(get.statusCode).toBe(200);
      expect(get.json().id).toBe(created.id);
    });

    it('returns 404 for unknown id', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const get = await app.inject({
        method: 'GET',
        url: `/videos/00000000-0000-0000-0000-000000000000`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });
      expect(get.statusCode).toBe(404);
    });
  });
});
