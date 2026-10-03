import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { signupVerified } from '../helpers/signup-user.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

e2eDescribe('e2e: exercise templates', () => {
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

  async function createTrainerWithToken() {
    const email = `e2e+exercise-tpl-trainer-${Date.now()}@example.com`;
    const password = 'StrongPassw0rd!';

    const signupResponse = await signupVerified(app, {
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

  async function createExerciseTemplate(accessToken, overrides = {}) {
    const response = await app.inject({
      method: 'POST',
      url: '/trainer/exercise-templates',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        name: 'Squat',
        type: 'strength',
        ...overrides,
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json();
  }

  // ==================== GET /trainer/exercise-templates ====================

  describe('GET /trainer/exercise-templates', () => {
    it('returns paginated envelope with data, total, page, limit', async () => {
      const { accessToken } = await createTrainerWithToken();
      await createExerciseTemplate(accessToken, { name: 'Bench Press', type: 'strength' });

      const response = await app.inject({
        method: 'GET',
        url: '/trainer/exercise-templates',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('total');
      expect(body).toHaveProperty('page', 1);
      expect(body).toHaveProperty('limit', 20);
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(body.total).toBe(1);
    });

    it('q filter returns only matching templates by name', async () => {
      const { accessToken } = await createTrainerWithToken();
      await createExerciseTemplate(accessToken, { name: 'Barbell Squat', type: 'strength' });
      await createExerciseTemplate(accessToken, { name: 'Bench Press', type: 'strength' });

      const response = await app.inject({
        method: 'GET',
        url: '/trainer/exercise-templates?q=squat',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.total).toBe(1);
      expect(body.data[0].name).toBe('Barbell Squat');
    });

    it('page=2 returns the second page when there are more items than the limit', async () => {
      const { accessToken } = await createTrainerWithToken();

      // Create 25 templates
      for (let i = 1; i <= 25; i++) {
        await createExerciseTemplate(accessToken, { name: `Exercise ${i}`, type: 'strength' });
      }

      const page2Response = await app.inject({
        method: 'GET',
        url: '/trainer/exercise-templates?page=2&limit=20',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(page2Response.statusCode).toBe(200);
      const body = page2Response.json();
      expect(body.page).toBe(2);
      expect(body.total).toBe(25);
      expect(body.data).toHaveLength(5);
    });

    it('type filter returns only templates with the matching type', async () => {
      const { accessToken } = await createTrainerWithToken();
      await createExerciseTemplate(accessToken, { name: 'Bench Press', type: 'strength' });
      await createExerciseTemplate(accessToken, { name: 'Treadmill', type: 'cardio' });

      const response = await app.inject({
        method: 'GET',
        url: '/trainer/exercise-templates?type=cardio',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.total).toBe(1);
      expect(body.data[0].name).toBe('Treadmill');
      expect(body.data[0].type).toBe('cardio');
    });

    it('returns 401 when not authenticated', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/trainer/exercise-templates',
      });

      expect(response.statusCode).toBe(401);
    });
  });

  // ==================== POST /trainer/exercise-templates/batch-delete ====================

  describe('POST /trainer/exercise-templates/batch-delete', () => {
    it('soft-deletes owned templates and returns deletedCount', async () => {
      const { accessToken } = await createTrainerWithToken();
      const et1 = await createExerciseTemplate(accessToken, { name: 'Squat', type: 'strength' });
      const et2 = await createExerciseTemplate(accessToken, { name: 'Deadlift', type: 'strength' });

      const deleteResponse = await app.inject({
        method: 'POST',
        url: '/trainer/exercise-templates/batch-delete',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { ids: [et1.id, et2.id] },
      });

      expect(deleteResponse.statusCode).toBe(200);
      expect(deleteResponse.json()).toEqual({ deletedCount: 2 });

      const listResponse = await app.inject({
        method: 'GET',
        url: '/trainer/exercise-templates',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(listResponse.json().total).toBe(0);
    });

    it('returns deletedCount 0 when IDs belong to another trainer', async () => {
      const { accessToken: trainerOneToken } = await createTrainerWithToken();
      const { accessToken: trainerTwoToken } = await createTrainerWithToken();
      const et = await createExerciseTemplate(trainerOneToken, { name: 'Owned By Trainer One', type: 'strength' });

      const deleteResponse = await app.inject({
        method: 'POST',
        url: '/trainer/exercise-templates/batch-delete',
        headers: { authorization: `Bearer ${trainerTwoToken}` },
        payload: { ids: [et.id] },
      });

      expect(deleteResponse.statusCode).toBe(200);
      expect(deleteResponse.json()).toEqual({ deletedCount: 0 });
    });

    it('returns 400 VALIDATION_ERROR when ids is empty', async () => {
      const { accessToken } = await createTrainerWithToken();

      const response = await app.inject({
        method: 'POST',
        url: '/trainer/exercise-templates/batch-delete',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { ids: [] },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body).toHaveProperty('error', 'VALIDATION_ERROR');
    });

    it('returns 400 VALIDATION_ERROR when ids contains a non-UUID string', async () => {
      const { accessToken } = await createTrainerWithToken();

      const response = await app.inject({
        method: 'POST',
        url: '/trainer/exercise-templates/batch-delete',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { ids: ['not-a-uuid'] },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body).toHaveProperty('error', 'VALIDATION_ERROR');
    });

    it('returns 401 when not authenticated', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/trainer/exercise-templates/batch-delete',
        payload: { ids: ['00000000-0000-0000-0000-000000000001'] },
      });

      expect(response.statusCode).toBe(401);
    });
  });
});
