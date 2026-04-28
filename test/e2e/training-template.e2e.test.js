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

  async function createAssigneeWithToken() {
    const email = `e2e+training-template-assignee-${Date.now()}@example.com`;
    const password = 'StrongPassw0rd!';

    const signupResponse = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password },
    });
    expect(signupResponse.statusCode).toBe(201);
    const { user: { id: userId }, token: { accessToken } } = signupResponse.json();
    return { userId, accessToken };
  }

  async function createProtocol(accessToken, assigneeId) {
    const response = await app.inject({
      method: 'POST',
      url: '/trainer/protocols',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { assigneeId, name: 'Protocol E2E', startDate: '2025-01-01' },
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

  // ==================== POST /trainer/training-templates/:templateId/exercises ====================

  describe('POST /trainer/training-templates/:templateId/exercises', () => {
    it('creates a new ExerciseTemplate and attaches it as a junction row', async () => {
      const { accessToken } = await createTrainerWithToken();
      const template = await createTrainingTemplate(accessToken, {});

      const response = await app.inject({
        method: 'POST',
        url: `/trainer/training-templates/${template.id}/exercises`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          name: 'Ad-hoc Squat',
          type: 'strength',
          sets: 4,
          repetitions: { min: 8, max: 12 },
          hasLoad: true,
          suggestedLoad: 60,
          restInterval: 90,
          notes: 'Controlled tempo',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body).toHaveProperty('id');
      expect(body).toHaveProperty('trainingTemplateId', template.id);
      expect(body).toHaveProperty('exerciseTemplateId');
      expect(body).toHaveProperty('name', 'Ad-hoc Squat');
      expect(body).toHaveProperty('sets', 4);
      expect(body).toHaveProperty('repetitions', { min: 8, max: 12 });
      expect(body).toHaveProperty('hasLoad', true);
      expect(body).toHaveProperty('suggestedLoad', 60);
      expect(body).toHaveProperty('restInterval', 90);
      expect(body).toHaveProperty('notes', 'Controlled tempo');
      expect(body).toHaveProperty('order', 0);
      expect(body.exerciseTemplate).toBeDefined();
      expect(body.exerciseTemplate.id).toBe(body.exerciseTemplateId);
    });

    it('assigns order = (max + 1) when existing exercises are present', async () => {
      const { accessToken } = await createTrainerWithToken();
      const exerciseTemplate = await createExerciseTemplate(accessToken, { name: 'Existing', type: 'strength' });
      const template = await createTrainingTemplate(accessToken, {
        exerciseTemplates: [
          { exerciseTemplateId: exerciseTemplate.id, order: 0 },
          { exerciseTemplateId: exerciseTemplate.id, order: 1 },
        ],
      });

      const response = await app.inject({
        method: 'POST',
        url: `/trainer/training-templates/${template.id}/exercises`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { name: 'New Exercise', type: 'strength' },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toHaveProperty('order', 2);
    });

    it('creates a new ExerciseTemplate owned by the caller (visible in library)', async () => {
      const { accessToken } = await createTrainerWithToken();
      const template = await createTrainingTemplate(accessToken, {});

      const createResponse = await app.inject({
        method: 'POST',
        url: `/trainer/training-templates/${template.id}/exercises`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { name: 'Library Entry', type: 'strength', sets: 3 },
      });
      expect(createResponse.statusCode).toBe(201);
      const created = createResponse.json();

      const libraryResponse = await app.inject({
        method: 'GET',
        url: '/trainer/exercise-templates',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(libraryResponse.statusCode).toBe(200);
      const library = libraryResponse.json();
      expect(library.some((t) => t.id === created.exerciseTemplateId)).toBe(true);
    });

    it('returns 400 when name is missing', async () => {
      const { accessToken } = await createTrainerWithToken();
      const template = await createTrainingTemplate(accessToken, {});

      const response = await app.inject({
        method: 'POST',
        url: `/trainer/training-templates/${template.id}/exercises`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { type: 'strength' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('returns 400 when type is missing', async () => {
      const { accessToken } = await createTrainerWithToken();
      const template = await createTrainingTemplate(accessToken, {});

      const response = await app.inject({
        method: 'POST',
        url: `/trainer/training-templates/${template.id}/exercises`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { name: 'Missing type' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('returns 404 when template does not exist', async () => {
      const { accessToken } = await createTrainerWithToken();
      const fakeTemplateId = '00000000-0000-0000-0000-000000000000';

      const response = await app.inject({
        method: 'POST',
        url: `/trainer/training-templates/${fakeTemplateId}/exercises`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { name: 'Orphan', type: 'strength' },
      });

      expect(response.statusCode).toBe(404);
    });

    it('returns 403 when trainer does not own the template', async () => {
      const { accessToken: trainerA } = await createTrainerWithToken();
      const { accessToken: trainerB } = await createTrainerWithToken();

      const template = await createTrainingTemplate(trainerA, {});

      const response = await app.inject({
        method: 'POST',
        url: `/trainer/training-templates/${template.id}/exercises`,
        headers: { authorization: `Bearer ${trainerB}` },
        payload: { name: 'Intruder', type: 'strength' },
      });

      expect(response.statusCode).toBe(403);
    });

    it('returns 401 without authentication', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/trainer/training-templates/00000000-0000-0000-0000-000000000000/exercises',
        payload: { name: 'Nope', type: 'strength' },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  // ==================== POST /trainer/training-templates/:templateId/exercises/from-template ====================

  describe('POST /trainer/training-templates/:templateId/exercises/from-template', () => {
    it('creates a junction row linking an existing ExerciseTemplate', async () => {
      const { accessToken } = await createTrainerWithToken();
      const exerciseTemplate = await createExerciseTemplate(accessToken, {
        name: 'Library Pull-Up',
        type: 'strength',
        sets: 3,
        hasLoad: false,
        restInterval: 60,
      });
      const template = await createTrainingTemplate(accessToken, {});

      const response = await app.inject({
        method: 'POST',
        url: `/trainer/training-templates/${template.id}/exercises/from-template`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { exerciseTemplateId: exerciseTemplate.id },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body).toHaveProperty('trainingTemplateId', template.id);
      expect(body).toHaveProperty('exerciseTemplateId', exerciseTemplate.id);
      expect(body).toHaveProperty('name', 'Library Pull-Up');
      expect(body).toHaveProperty('sets', 3);
      expect(body).toHaveProperty('hasLoad', false);
      expect(body).toHaveProperty('restInterval', 60);
      expect(body).toHaveProperty('order', 0);
      expect(body.exerciseTemplate).toBeDefined();
      expect(body.exerciseTemplate.id).toBe(exerciseTemplate.id);
    });

    it('does not create a new ExerciseTemplate (reuses the provided one)', async () => {
      const { accessToken } = await createTrainerWithToken();
      const exerciseTemplate = await createExerciseTemplate(accessToken, { name: 'Reuse me', type: 'strength' });
      const template = await createTrainingTemplate(accessToken, {});

      const beforeResponse = await app.inject({
        method: 'GET',
        url: '/trainer/exercise-templates',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      const beforeCount = beforeResponse.json().length;

      await app.inject({
        method: 'POST',
        url: `/trainer/training-templates/${template.id}/exercises/from-template`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { exerciseTemplateId: exerciseTemplate.id },
      });

      const afterResponse = await app.inject({
        method: 'GET',
        url: '/trainer/exercise-templates',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(afterResponse.json().length).toBe(beforeCount);
    });

    it('assigns order = (max + 1) when exercises already exist', async () => {
      const { accessToken } = await createTrainerWithToken();
      const seed = await createExerciseTemplate(accessToken, { name: 'Seed', type: 'strength' });
      const template = await createTrainingTemplate(accessToken, {
        exerciseTemplates: [{ exerciseTemplateId: seed.id, order: 0 }],
      });
      const other = await createExerciseTemplate(accessToken, { name: 'Imported', type: 'strength' });

      const response = await app.inject({
        method: 'POST',
        url: `/trainer/training-templates/${template.id}/exercises/from-template`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { exerciseTemplateId: other.id },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toHaveProperty('order', 1);
    });

    it('returns 400 when exerciseTemplateId is missing', async () => {
      const { accessToken } = await createTrainerWithToken();
      const template = await createTrainingTemplate(accessToken, {});

      const response = await app.inject({
        method: 'POST',
        url: `/trainer/training-templates/${template.id}/exercises/from-template`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {},
      });

      expect(response.statusCode).toBe(400);
    });

    it('returns 404 when exerciseTemplate does not exist', async () => {
      const { accessToken } = await createTrainerWithToken();
      const template = await createTrainingTemplate(accessToken, {});

      const response = await app.inject({
        method: 'POST',
        url: `/trainer/training-templates/${template.id}/exercises/from-template`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { exerciseTemplateId: '00000000-0000-0000-0000-000000000000' },
      });

      expect(response.statusCode).toBe(404);
    });

    it('returns 404 when the exerciseTemplate belongs to another trainer', async () => {
      const { accessToken: trainerA } = await createTrainerWithToken();
      const { accessToken: trainerB } = await createTrainerWithToken();

      const foreignExercise = await createExerciseTemplate(trainerA, { name: 'Private', type: 'strength' });
      const template = await createTrainingTemplate(trainerB, {});

      const response = await app.inject({
        method: 'POST',
        url: `/trainer/training-templates/${template.id}/exercises/from-template`,
        headers: { authorization: `Bearer ${trainerB}` },
        payload: { exerciseTemplateId: foreignExercise.id },
      });

      expect(response.statusCode).toBe(404);
    });

    it('returns 404 when the training template does not exist', async () => {
      const { accessToken } = await createTrainerWithToken();
      const exerciseTemplate = await createExerciseTemplate(accessToken, { name: 'Solo', type: 'strength' });

      const response = await app.inject({
        method: 'POST',
        url: '/trainer/training-templates/00000000-0000-0000-0000-000000000000/exercises/from-template',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { exerciseTemplateId: exerciseTemplate.id },
      });

      expect(response.statusCode).toBe(404);
    });

    it('returns 403 when trainer does not own the template', async () => {
      const { accessToken: trainerA } = await createTrainerWithToken();
      const { accessToken: trainerB } = await createTrainerWithToken();

      const template = await createTrainingTemplate(trainerA, {});
      const exerciseTemplate = await createExerciseTemplate(trainerB, { name: 'Mine', type: 'strength' });

      const response = await app.inject({
        method: 'POST',
        url: `/trainer/training-templates/${template.id}/exercises/from-template`,
        headers: { authorization: `Bearer ${trainerB}` },
        payload: { exerciseTemplateId: exerciseTemplate.id },
      });

      expect(response.statusCode).toBe(403);
    });

    it('returns 401 without authentication', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/trainer/training-templates/00000000-0000-0000-0000-000000000000/exercises/from-template',
        payload: { exerciseTemplateId: '00000000-0000-0000-0000-000000000001' },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  // ==================== DELETE /trainer/training-templates/:templateId/exercises/:exerciseId ====================

  describe('DELETE /trainer/training-templates/:templateId/exercises/:exerciseId', () => {
    it('removes the junction row and returns its final snapshot', async () => {
      const { accessToken } = await createTrainerWithToken();
      const exerciseTemplate = await createExerciseTemplate(accessToken, {
        name: 'Throwaway',
        type: 'strength',
        sets: 3,
      });
      const template = await createTrainingTemplate(accessToken, {
        exerciseTemplates: [{ exerciseTemplateId: exerciseTemplate.id }],
      });
      const junction = template.trainingTemplateExerciseTemplates[0];

      const response = await app.inject({
        method: 'DELETE',
        url: `/trainer/training-templates/${template.id}/exercises/${junction.id}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('id', junction.id);
      expect(body).toHaveProperty('exerciseTemplateId', exerciseTemplate.id);

      // Verify the junction row is actually gone
      const refetch = await app.inject({
        method: 'GET',
        url: `/trainer/training-templates/${template.id}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(refetch.statusCode).toBe(200);
      expect(refetch.json().trainingTemplateExerciseTemplates).toHaveLength(0);
    });

    it('leaves the underlying ExerciseTemplate intact in the library', async () => {
      const { accessToken } = await createTrainerWithToken();
      const exerciseTemplate = await createExerciseTemplate(accessToken, {
        name: 'Keep me',
        type: 'strength',
      });
      const template = await createTrainingTemplate(accessToken, {
        exerciseTemplates: [{ exerciseTemplateId: exerciseTemplate.id }],
      });
      const junction = template.trainingTemplateExerciseTemplates[0];

      const deleteResponse = await app.inject({
        method: 'DELETE',
        url: `/trainer/training-templates/${template.id}/exercises/${junction.id}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(deleteResponse.statusCode).toBe(200);

      const libraryResponse = await app.inject({
        method: 'GET',
        url: `/trainer/exercise-templates/${exerciseTemplate.id}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(libraryResponse.statusCode).toBe(200);
      expect(libraryResponse.json()).toHaveProperty('id', exerciseTemplate.id);
      expect(libraryResponse.json()).toHaveProperty('name', 'Keep me');
    });

    it('is idempotent: deleting a junction twice returns 404 on the second call', async () => {
      const { accessToken } = await createTrainerWithToken();
      const exerciseTemplate = await createExerciseTemplate(accessToken, { name: 'Twice', type: 'strength' });
      const template = await createTrainingTemplate(accessToken, {
        exerciseTemplates: [{ exerciseTemplateId: exerciseTemplate.id }],
      });
      const junction = template.trainingTemplateExerciseTemplates[0];

      const first = await app.inject({
        method: 'DELETE',
        url: `/trainer/training-templates/${template.id}/exercises/${junction.id}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: 'DELETE',
        url: `/trainer/training-templates/${template.id}/exercises/${junction.id}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(second.statusCode).toBe(404);
    });

    it('returns 404 when the junction row does not exist in the template', async () => {
      const { accessToken } = await createTrainerWithToken();
      const template = await createTrainingTemplate(accessToken, {});
      const fakeExerciseId = '00000000-0000-0000-0000-000000000000';

      const response = await app.inject({
        method: 'DELETE',
        url: `/trainer/training-templates/${template.id}/exercises/${fakeExerciseId}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(response.statusCode).toBe(404);
    });

    it('returns 404 when the training template does not exist', async () => {
      const { accessToken } = await createTrainerWithToken();

      const response = await app.inject({
        method: 'DELETE',
        url: '/trainer/training-templates/00000000-0000-0000-0000-000000000000/exercises/00000000-0000-0000-0000-000000000001',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(response.statusCode).toBe(404);
    });

    it('returns 403 when trainer does not own the template', async () => {
      const { accessToken: trainerA } = await createTrainerWithToken();
      const { accessToken: trainerB } = await createTrainerWithToken();

      const exerciseTemplate = await createExerciseTemplate(trainerA, { name: 'Owned', type: 'strength' });
      const template = await createTrainingTemplate(trainerA, {
        exerciseTemplates: [{ exerciseTemplateId: exerciseTemplate.id }],
      });
      const junction = template.trainingTemplateExerciseTemplates[0];

      const response = await app.inject({
        method: 'DELETE',
        url: `/trainer/training-templates/${template.id}/exercises/${junction.id}`,
        headers: { authorization: `Bearer ${trainerB}` },
      });

      expect(response.statusCode).toBe(403);
    });

    it('returns 401 without authentication', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: '/trainer/training-templates/00000000-0000-0000-0000-000000000000/exercises/00000000-0000-0000-0000-000000000001',
      });

      expect(response.statusCode).toBe(401);
    });
  });

  // ==================== POST /trainer/trainings/from-template ====================

  describe('POST /trainer/trainings/from-template', () => {
    it('returns 201 with populated exercises array when template has exercises', async () => {
      const { accessToken } = await createTrainerWithToken();
      const { userId: assigneeId } = await createAssigneeWithToken();
      const protocol = await createProtocol(accessToken, assigneeId);

      const exerciseTemplate = await createExerciseTemplate(accessToken, {
        name: 'Agachamento',
        type: 'strength',
        sets: 4,
        repetitions: { min: 8, max: 12 },
        hasLoad: true,
        suggestedLoad: 80,
        restInterval: 120,
        notes: 'Manter costas retas',
      });

      const trainingTemplate = await createTrainingTemplate(accessToken, {
        name: 'Pernas',
        category: 'strength',
        exerciseTemplates: [
          { exerciseTemplateId: exerciseTemplate.id, order: 0 },
          { exerciseTemplateId: exerciseTemplate.id, order: 1 },
        ],
      });

      const response = await app.inject({
        method: 'POST',
        url: '/trainer/trainings/from-template',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { protocolId: protocol.id, templateId: trainingTemplate.id },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();

      expect(body).toHaveProperty('id');
      expect(body).toHaveProperty('exercises');
      expect(body.exercises).toHaveLength(trainingTemplate.trainingTemplateExerciseTemplates.length);

      const firstExercise = body.exercises[0];
      const firstJunction = trainingTemplate.trainingTemplateExerciseTemplates[0];
      expect(firstExercise.order).toBe(firstJunction.order);
      expect(firstExercise.name).toBe(firstJunction.name);
      expect(firstExercise.sets).toBe(firstJunction.sets);
      expect(firstExercise.restInterval).toBe(firstJunction.restInterval);
    });

    it('returns exercises ordered ascending by order field', async () => {
      const { accessToken } = await createTrainerWithToken();
      const { userId: assigneeId } = await createAssigneeWithToken();
      const protocol = await createProtocol(accessToken, assigneeId);

      const et1 = await createExerciseTemplate(accessToken, { name: 'Supino', type: 'strength', sets: 3 });
      const et2 = await createExerciseTemplate(accessToken, { name: 'Crucifixo', type: 'strength', sets: 3 });

      const trainingTemplate = await createTrainingTemplate(accessToken, {
        name: 'Peito',
        category: 'strength',
        exerciseTemplates: [
          { exerciseTemplateId: et2.id, order: 1 },
          { exerciseTemplateId: et1.id, order: 0 },
        ],
      });

      const response = await app.inject({
        method: 'POST',
        url: '/trainer/trainings/from-template',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { protocolId: protocol.id, templateId: trainingTemplate.id },
      });

      expect(response.statusCode).toBe(201);
      const { exercises } = response.json();
      expect(exercises).toHaveLength(2);
      expect(exercises[0].order).toBe(0);
      expect(exercises[1].order).toBe(1);
    });

    it('returns 201 with exercises as empty array when template has zero exercises', async () => {
      const { accessToken } = await createTrainerWithToken();
      const { userId: assigneeId } = await createAssigneeWithToken();
      const protocol = await createProtocol(accessToken, assigneeId);

      const trainingTemplate = await createTrainingTemplate(accessToken, {
        name: 'Cardio Vazio',
        category: 'cardio',
      });

      const response = await app.inject({
        method: 'POST',
        url: '/trainer/trainings/from-template',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { protocolId: protocol.id, templateId: trainingTemplate.id },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body).toHaveProperty('exercises');
      expect(body.exercises).toEqual([]);
    });

    it('returns 401 without authentication', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/trainer/trainings/from-template',
        payload: {
          protocolId: '00000000-0000-0000-0000-000000000000',
          templateId: '00000000-0000-0000-0000-000000000001',
        },
      });

      expect(response.statusCode).toBe(401);
    });

    it('returns 404 when template does not exist', async () => {
      const { accessToken } = await createTrainerWithToken();
      const { userId: assigneeId } = await createAssigneeWithToken();
      const protocol = await createProtocol(accessToken, assigneeId);

      const response = await app.inject({
        method: 'POST',
        url: '/trainer/trainings/from-template',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          protocolId: protocol.id,
          templateId: '00000000-0000-0000-0000-000000000099',
        },
      });

      expect(response.statusCode).toBe(404);
    });
  });
});
