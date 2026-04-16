import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

e2eDescribe('e2e: training templates', () => {
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
    const email = `e2e+training-template-trainer-${Date.now()}@example.com`;
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

  async function createExerciseTemplate(accessToken, overrides = {}) {
    const response = await app.inject({
      method: 'POST',
      url: '/trainer/exercise-templates',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        name: 'Barbell Squat',
        type: 'strength',
        sets: 4,
        repetitions: { min: 8, max: 12 },
        hasLoad: true,
        suggestedLoad: 60,
        restInterval: 90,
        notes: 'Keep back straight',
        ...overrides,
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json();
  }

  async function createTrainingTemplate(accessToken, payload) {
    const response = await app.inject({
      method: 'POST',
      url: '/trainer/training-templates',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        name: 'Leg Day',
        category: 'strength',
        ...payload,
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json();
  }

  // ==================== POST /trainer/training-templates ====================

  describe('POST /trainer/training-templates', () => {
    it('creates template without exercises', async () => {
      const { accessToken } = await createTrainerWithToken();

      const response = await app.inject({
        method: 'POST',
        url: '/trainer/training-templates',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { name: 'Push Day', category: 'strength' },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body).toHaveProperty('id');
      expect(body).toHaveProperty('name', 'Push Day');
      expect(body).toHaveProperty('category', 'strength');
      expect(body.trainingTemplateExerciseTemplates).toHaveLength(0);
    });

    it('snapshots exercise template fields into junction rows at create time', async () => {
      const { accessToken } = await createTrainerWithToken();
      const exerciseTemplate = await createExerciseTemplate(accessToken, {
        name: 'Bench Press',
        type: 'strength',
        sets: 5,
        repetitions: { min: 5, max: 5 },
        hasLoad: true,
        suggestedLoad: 80,
        restInterval: 120,
        notes: 'Controlled descent',
      });

      const response = await app.inject({
        method: 'POST',
        url: '/trainer/training-templates',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          name: 'Chest Day',
          category: 'strength',
          exerciseTemplates: [{ exerciseTemplateId: exerciseTemplate.id }],
        },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.trainingTemplateExerciseTemplates).toHaveLength(1);

      const junction = body.trainingTemplateExerciseTemplates[0];
      expect(junction).toHaveProperty('name', 'Bench Press');
      expect(junction).toHaveProperty('type', 'strength');
      expect(junction).toHaveProperty('sets', 5);
      expect(junction).toHaveProperty('repetitions', { min: 5, max: 5 });
      expect(junction).toHaveProperty('hasLoad', true);
      expect(junction).toHaveProperty('suggestedLoad', 80);
      expect(junction).toHaveProperty('restInterval', 120);
      expect(junction).toHaveProperty('notes', 'Controlled descent');
      expect(junction).toHaveProperty('exerciseTemplateId', exerciseTemplate.id);
    });

    it('allows same exerciseTemplateId linked twice (unique constraint removed)', async () => {
      const { accessToken } = await createTrainerWithToken();
      const exerciseTemplate = await createExerciseTemplate(accessToken, {
        name: 'Squat',
        type: 'strength',
        sets: 4,
        hasLoad: true,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/trainer/training-templates',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          name: 'Double Squat Day',
          category: 'strength',
          exerciseTemplates: [
            { exerciseTemplateId: exerciseTemplate.id, order: 0 },
            { exerciseTemplateId: exerciseTemplate.id, order: 1 },
          ],
        },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.trainingTemplateExerciseTemplates).toHaveLength(2);
      expect(body.trainingTemplateExerciseTemplates[0].exerciseTemplateId).toBe(exerciseTemplate.id);
      expect(body.trainingTemplateExerciseTemplates[1].exerciseTemplateId).toBe(exerciseTemplate.id);
      expect(body.trainingTemplateExerciseTemplates[0].order).toBe(0);
      expect(body.trainingTemplateExerciseTemplates[1].order).toBe(1);
    });

    it('returns 401 without authentication', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/trainer/training-templates',
        payload: { name: 'Leg Day', category: 'strength' },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  // ==================== PATCH /trainer/training-templates/:templateId/exercises/:exerciseId ====================

  describe('PATCH /trainer/training-templates/:templateId/exercises/:exerciseId', () => {
    it('updates junction row snapshot fields without touching the ExerciseTemplate', async () => {
      const { accessToken } = await createTrainerWithToken();
      const exerciseTemplate = await createExerciseTemplate(accessToken, {
        name: 'Romanian Deadlift',
        type: 'strength',
        sets: 3,
        hasLoad: true,
        suggestedLoad: 70,
      });

      const template = await createTrainingTemplate(accessToken, {
        exerciseTemplates: [{ exerciseTemplateId: exerciseTemplate.id }],
      });

      const junction = template.trainingTemplateExerciseTemplates[0];
      expect(junction.sets).toBe(3);

      const patchResponse = await app.inject({
        method: 'PATCH',
        url: `/trainer/training-templates/${template.id}/exercises/${junction.id}`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { sets: 5 },
      });

      expect(patchResponse.statusCode).toBe(200);
      const updated = patchResponse.json();
      expect(updated).toHaveProperty('id', junction.id);
      expect(updated).toHaveProperty('sets', 5);
    });

    it('does NOT modify the original ExerciseTemplate when patching a junction row', async () => {
      const { accessToken } = await createTrainerWithToken();
      const exerciseTemplate = await createExerciseTemplate(accessToken, {
        name: 'Overhead Press',
        type: 'strength',
        sets: 4,
        hasLoad: true,
        suggestedLoad: 50,
      });

      const template = await createTrainingTemplate(accessToken, {
        exerciseTemplates: [{ exerciseTemplateId: exerciseTemplate.id }],
      });

      const junction = template.trainingTemplateExerciseTemplates[0];

      await app.inject({
        method: 'PATCH',
        url: `/trainer/training-templates/${template.id}/exercises/${junction.id}`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { sets: 10, suggestedLoad: 999, notes: 'Changed in junction only' },
      });

      // Fetch the original ExerciseTemplate and verify it is unchanged
      const exerciseTemplatesResponse = await app.inject({
        method: 'GET',
        url: '/trainer/exercise-templates',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(exerciseTemplatesResponse.statusCode).toBe(200);
      const templates = exerciseTemplatesResponse.json();
      const original = templates.find((t) => t.id === exerciseTemplate.id);
      expect(original).toBeDefined();
      expect(original.sets).toBe(4);
      expect(original.suggestedLoad).toBe(50);
    });

    it('updates multiple snapshot fields in a single PATCH', async () => {
      const { accessToken } = await createTrainerWithToken();
      const exerciseTemplate = await createExerciseTemplate(accessToken, {
        name: 'Pull Up',
        type: 'strength',
        sets: 3,
        hasLoad: false,
        restInterval: 60,
      });

      const template = await createTrainingTemplate(accessToken, {
        exerciseTemplates: [{ exerciseTemplateId: exerciseTemplate.id }],
      });
      const junction = template.trainingTemplateExerciseTemplates[0];

      const patchResponse = await app.inject({
        method: 'PATCH',
        url: `/trainer/training-templates/${template.id}/exercises/${junction.id}`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { sets: 4, restInterval: 90, notes: 'Add weight if easy', order: 2 },
      });

      expect(patchResponse.statusCode).toBe(200);
      const updated = patchResponse.json();
      expect(updated).toHaveProperty('sets', 4);
      expect(updated).toHaveProperty('restInterval', 90);
      expect(updated).toHaveProperty('notes', 'Add weight if easy');
      expect(updated).toHaveProperty('order', 2);
    });

    it('returns 404 when the exercise junction row does not exist in the template', async () => {
      const { accessToken } = await createTrainerWithToken();
      const template = await createTrainingTemplate(accessToken, {});
      const fakeExerciseId = '00000000-0000-0000-0000-000000000000';

      const patchResponse = await app.inject({
        method: 'PATCH',
        url: `/trainer/training-templates/${template.id}/exercises/${fakeExerciseId}`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { sets: 3 },
      });

      expect(patchResponse.statusCode).toBe(404);
    });

    it('returns 403 when trainer does not own the template', async () => {
      const { accessToken: trainerA } = await createTrainerWithToken();
      const { accessToken: trainerB } = await createTrainerWithToken();

      const exerciseTemplate = await createExerciseTemplate(trainerA, { name: 'Squat', type: 'strength' });
      const template = await createTrainingTemplate(trainerA, {
        exerciseTemplates: [{ exerciseTemplateId: exerciseTemplate.id }],
      });
      const junction = template.trainingTemplateExerciseTemplates[0];

      const patchResponse = await app.inject({
        method: 'PATCH',
        url: `/trainer/training-templates/${template.id}/exercises/${junction.id}`,
        headers: { authorization: `Bearer ${trainerB}` },
        payload: { sets: 3 },
      });

      expect(patchResponse.statusCode).toBe(403);
    });

    it('returns 401 without authentication', async () => {
      const { accessToken } = await createTrainerWithToken();
      const template = await createTrainingTemplate(accessToken, {});
      const fakeExerciseId = '00000000-0000-0000-0000-000000000001';

      const patchResponse = await app.inject({
        method: 'PATCH',
        url: `/trainer/training-templates/${template.id}/exercises/${fakeExerciseId}`,
        payload: { sets: 3 },
      });

      expect(patchResponse.statusCode).toBe(401);
    });
  });
});
