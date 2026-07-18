import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { prisma } from '../../src/db.js';

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
    // Library templates now carry only identity (name, type, videoUrl, isPublic).
    // Prescription fields are stripped before sending.
    const { sets, repetitions, hasLoad, suggestedLoad, restInterval, notes, prescriptionMode, intensity, duration, ...identityOverrides } = overrides;
    const response = await app.inject({
      method: 'POST',
      url: '/trainer/exercise-templates',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        name: 'Barbell Squat',
        type: 'strength',
        ...identityOverrides,
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

  // Platform plan guard (assertStudentActiveOnPlan) requires an active
  // TrainerStudent link before protocol creation. Resolve trainer.id via /me
  // and upsert the link.
  async function activatePlanLink(trainerToken, assigneeId) {
    const meRes = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${trainerToken}` },
    });
    expect(meRes.statusCode).toBe(200);
    const trainer = await prisma.trainer.findUnique({
      where: { userId: meRes.json().id },
      select: { id: true },
    });
    await prisma.trainerStudent.upsert({
      where: { trainerId_studentId: { trainerId: trainer.id, studentId: assigneeId } },
      create: { trainerId: trainer.id, studentId: assigneeId, activeOnPlan: true },
      update: { activeOnPlan: true },
    });
  }

  async function createProtocol(accessToken, assigneeId) {
    await activatePlanLink(accessToken, assigneeId);

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

    it('junction row gets identity from library template and null prescription defaults', async () => {
      const { accessToken } = await createTrainerWithToken();
      const exerciseTemplate = await createExerciseTemplate(accessToken, {
        name: 'Bench Press',
        type: 'strength',
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
      // Identity comes from the library template
      expect(junction).toHaveProperty('name', 'Bench Press');
      expect(junction).toHaveProperty('type', 'strength');
      expect(junction).toHaveProperty('exerciseTemplateId', exerciseTemplate.id);
      // Prescription defaults to null / REPS when not specified
      expect(junction).toHaveProperty('sets', null);
      expect(junction).toHaveProperty('repetitions', null);
      expect(junction).toHaveProperty('hasLoad', false);
      expect(junction).toHaveProperty('suggestedLoad', null);
      expect(junction).toHaveProperty('restInterval', null);
      expect(junction).toHaveProperty('notes', null);
      expect(junction).toHaveProperty('prescriptionMode', 'reps');
    });

    it('caller-supplied prescription overrides null defaults in junction rows', async () => {
      const { accessToken } = await createTrainerWithToken();
      const exerciseTemplate = await createExerciseTemplate(accessToken, {
        name: 'Bench Press',
        type: 'strength',
      });

      const response = await app.inject({
        method: 'POST',
        url: '/trainer/training-templates',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          name: 'Chest Day',
          category: 'strength',
          exerciseTemplates: [{
            exerciseTemplateId: exerciseTemplate.id,
            sets: 5,
            repetitions: { min: 5, max: 5 },
            hasLoad: true,
            suggestedLoad: 80,
            restInterval: 120,
            notes: 'Controlled descent',
          }],
        },
      });

      expect(response.statusCode).toBe(201);
      const junction = response.json().trainingTemplateExerciseTemplates[0];
      expect(junction).toHaveProperty('sets', 5);
      expect(junction).toHaveProperty('repetitions', { min: 5, max: 5 });
      expect(junction).toHaveProperty('hasLoad', true);
      expect(junction).toHaveProperty('suggestedLoad', 80);
      expect(junction).toHaveProperty('restInterval', 120);
      expect(junction).toHaveProperty('notes', 'Controlled descent');
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

    it('accepts a PUBLIC exercise template owned by another trainer', async () => {
      const { accessToken: trainerA } = await createTrainerWithToken();
      const { accessToken: trainerB } = await createTrainerWithToken();

      // Trainer A creates a public exercise template
      const publicExercise = await createExerciseTemplate(trainerA, {
        name: 'Community Deadlift',
        type: 'strength',
        isPublic: true,
      });

      // Trainer B creates a training template referencing Trainer A's public exercise
      const response = await app.inject({
        method: 'POST',
        url: '/trainer/training-templates',
        headers: { authorization: `Bearer ${trainerB}` },
        payload: {
          name: 'Borrowed Template',
          category: 'strength',
          exerciseTemplates: [{ exerciseTemplateId: publicExercise.id }],
        },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body).toHaveProperty('id');
      expect(body.trainingTemplateExerciseTemplates).toHaveLength(1);
      const junction = body.trainingTemplateExerciseTemplates[0];
      expect(junction).toHaveProperty('exerciseTemplateId', publicExercise.id);
      // Identity snapshotted from the public template
      expect(junction).toHaveProperty('name', 'Community Deadlift');
      expect(junction).toHaveProperty('type', 'strength');
    });

    it('rejects a PRIVATE exercise template owned by another trainer with 404', async () => {
      const { accessToken: trainerA } = await createTrainerWithToken();
      const { accessToken: trainerB } = await createTrainerWithToken();

      // Trainer A creates a private exercise template (isPublic defaults to false)
      const privateExercise = await createExerciseTemplate(trainerA, {
        name: 'Private Squat',
        type: 'strength',
      });

      const response = await app.inject({
        method: 'POST',
        url: '/trainer/training-templates',
        headers: { authorization: `Bearer ${trainerB}` },
        payload: {
          name: 'Forbidden Template',
          category: 'strength',
          exerciseTemplates: [{ exerciseTemplateId: privateExercise.id }],
        },
      });

      expect(response.statusCode).toBe(404);
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
    it('updates junction row prescription fields without touching the ExerciseTemplate', async () => {
      const { accessToken } = await createTrainerWithToken();
      const exerciseTemplate = await createExerciseTemplate(accessToken, {
        name: 'Romanian Deadlift',
        type: 'strength',
      });

      // Create template with no prescription — junction starts with null prescription
      const template = await createTrainingTemplate(accessToken, {
        exerciseTemplates: [{ exerciseTemplateId: exerciseTemplate.id }],
      });

      const junction = template.trainingTemplateExerciseTemplates[0];
      // Junction prescription defaults to null
      expect(junction.sets).toBeNull();

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
      });

      const template = await createTrainingTemplate(accessToken, {
        exerciseTemplates: [{ exerciseTemplateId: exerciseTemplate.id }],
      });

      const junction = template.trainingTemplateExerciseTemplates[0];

      await app.inject({
        method: 'PATCH',
        url: `/trainer/training-templates/${template.id}/exercises/${junction.id}`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { sets: 10, notes: 'Changed in junction only' },
      });

      // Fetch the original ExerciseTemplate and verify it is unchanged (identity only)
      const exerciseTemplatesResponse = await app.inject({
        method: 'GET',
        url: '/trainer/exercise-templates',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(exerciseTemplatesResponse.statusCode).toBe(200);
      const { data: templates } = exerciseTemplatesResponse.json();
      const original = templates.find((t) => t.id === exerciseTemplate.id);
      expect(original).toBeDefined();
      // Library template has no prescription fields
      expect(original).not.toHaveProperty('sets');
      expect(original).not.toHaveProperty('suggestedLoad');
    });

    it('updates multiple junction prescription fields in a single PATCH', async () => {
      const { accessToken } = await createTrainerWithToken();
      const exerciseTemplate = await createExerciseTemplate(accessToken, {
        name: 'Pull Up',
        type: 'strength',
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

    it('persists intensity when patching a cardio junction row', async () => {
      const { accessToken } = await createTrainerWithToken();
      const exerciseTemplate = await createExerciseTemplate(accessToken, {
        name: 'Running',
        type: 'cardio',
      });

      const template = await createTrainingTemplate(accessToken, {
        exerciseTemplates: [{ exerciseTemplateId: exerciseTemplate.id }],
      });

      const junction = template.trainingTemplateExerciseTemplates[0];

      const patchResponse = await app.inject({
        method: 'PATCH',
        url: `/trainer/training-templates/${template.id}/exercises/${junction.id}`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { intensity: 'vigorous' },
      });

      expect(patchResponse.statusCode).toBe(200);
      const updated = patchResponse.json();
      expect(updated).toHaveProperty('id', junction.id);
      expect(updated).toHaveProperty('intensity', 'vigorous');
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
      const { data: library } = libraryResponse.json();
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
    it('creates a junction row linking an existing ExerciseTemplate with null prescription defaults', async () => {
      const { accessToken } = await createTrainerWithToken();
      // ExerciseTemplate is identity-only — no prescription stored on it
      const exerciseTemplate = await createExerciseTemplate(accessToken, {
        name: 'Library Pull-Up',
        type: 'strength',
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
      // Prescription defaults to null on the junction when caller provides none
      expect(body).toHaveProperty('sets', null);
      expect(body).toHaveProperty('hasLoad', false);
      expect(body).toHaveProperty('restInterval', null);
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
      const beforeCount = beforeResponse.json().total;

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
      expect(afterResponse.json().total).toBe(beforeCount);
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

    it('returns 404 when the exerciseTemplate is private and belongs to another trainer', async () => {
      const { accessToken: trainerA } = await createTrainerWithToken();
      const { accessToken: trainerB } = await createTrainerWithToken();

      // isPublic defaults to false — private template
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

    it('succeeds when the exerciseTemplate is public and belongs to another trainer', async () => {
      const { accessToken: trainerA } = await createTrainerWithToken();
      const { accessToken: trainerB } = await createTrainerWithToken();

      // Trainer A creates a public exercise template
      const publicExercise = await createExerciseTemplate(trainerA, {
        name: 'Public Lunge',
        type: 'strength',
        isPublic: true,
      });

      // Trainer B creates their own training template and links A's public exercise
      const template = await createTrainingTemplate(trainerB, {});

      const response = await app.inject({
        method: 'POST',
        url: `/trainer/training-templates/${template.id}/exercises/from-template`,
        headers: { authorization: `Bearer ${trainerB}` },
        payload: {
          exerciseTemplateId: publicExercise.id,
          sets: 3,
          prescriptionMode: 'reps',
          repetitions: { min: 12, max: 15 },
        },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body).toHaveProperty('trainingTemplateId', template.id);
      expect(body).toHaveProperty('exerciseTemplateId', publicExercise.id);
      // Identity snapshotted from the public template
      expect(body).toHaveProperty('name', 'Public Lunge');
      expect(body).toHaveProperty('type', 'strength');
      // Prescription from caller input
      expect(body).toHaveProperty('sets', 3);
      expect(body).toHaveProperty('repetitions', { min: 12, max: 15 });
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

  // ==================== GET /trainer/training-templates (paginated) ====================

  describe('GET /trainer/training-templates', () => {
    it('returns paginated envelope with data, total, page, limit', async () => {
      const { accessToken } = await createTrainerWithToken();
      await createTrainingTemplate(accessToken, { name: 'Leg Day', category: 'strength' });

      const response = await app.inject({
        method: 'GET',
        url: '/trainer/training-templates',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('total');
      expect(body).toHaveProperty('page', 1);
      expect(body).toHaveProperty('limit', 20);
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.total).toBe(1);
    });

    it('q filter returns only matching templates by name', async () => {
      const { accessToken } = await createTrainerWithToken();
      await createTrainingTemplate(accessToken, { name: 'Leg Day', category: 'strength' });
      await createTrainingTemplate(accessToken, { name: 'Push Day', category: 'strength' });

      const response = await app.inject({
        method: 'GET',
        url: '/trainer/training-templates?q=leg',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.total).toBe(1);
      expect(body.data[0].name).toBe('Leg Day');
    });

    it('page=2 returns the second page when there are more items than the limit', async () => {
      const { accessToken } = await createTrainerWithToken();

      for (let i = 1; i <= 25; i++) {
        await createTrainingTemplate(accessToken, { name: `Training ${i}`, category: 'strength' });
      }

      const page2Response = await app.inject({
        method: 'GET',
        url: '/trainer/training-templates?page=2&limit=20',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(page2Response.statusCode).toBe(200);
      const body = page2Response.json();
      expect(body.page).toBe(2);
      expect(body.total).toBe(25);
      expect(body.data).toHaveLength(5);
    });

    it('category filter returns only templates with the matching category', async () => {
      const { accessToken } = await createTrainerWithToken();
      await createTrainingTemplate(accessToken, { name: 'Strength Day', category: 'strength' });
      await createTrainingTemplate(accessToken, { name: 'Cardio Day', category: 'cardio' });

      const response = await app.inject({
        method: 'GET',
        url: '/trainer/training-templates?category=cardio',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.total).toBe(1);
      expect(body.data[0].name).toBe('Cardio Day');
      expect(body.data[0].category).toBe('cardio');
    });
  });

  // ==================== POST /trainer/training-templates/batch-delete ====================

  describe('POST /trainer/training-templates/batch-delete', () => {
    it('soft-deletes owned templates and returns deletedCount', async () => {
      const { accessToken } = await createTrainerWithToken();
      const tt1 = await createTrainingTemplate(accessToken, { name: 'Leg Day', category: 'strength' });
      const tt2 = await createTrainingTemplate(accessToken, { name: 'Push Day', category: 'strength' });

      const deleteResponse = await app.inject({
        method: 'POST',
        url: '/trainer/training-templates/batch-delete',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { ids: [tt1.id, tt2.id] },
      });

      expect(deleteResponse.statusCode).toBe(200);
      expect(deleteResponse.json()).toEqual({ deletedCount: 2 });

      const listResponse = await app.inject({
        method: 'GET',
        url: '/trainer/training-templates',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(listResponse.json().total).toBe(0);
    });

    it('returns deletedCount 0 when IDs belong to another trainer', async () => {
      const { accessToken: trainerOneToken } = await createTrainerWithToken();
      const { accessToken: trainerTwoToken } = await createTrainerWithToken();
      const tt = await createTrainingTemplate(trainerOneToken, { name: 'Owned By Trainer One', category: 'strength' });

      const deleteResponse = await app.inject({
        method: 'POST',
        url: '/trainer/training-templates/batch-delete',
        headers: { authorization: `Bearer ${trainerTwoToken}` },
        payload: { ids: [tt.id] },
      });

      expect(deleteResponse.statusCode).toBe(200);
      expect(deleteResponse.json()).toEqual({ deletedCount: 0 });
    });

    it('returns 400 VALIDATION_ERROR when ids is empty', async () => {
      const { accessToken } = await createTrainerWithToken();

      const response = await app.inject({
        method: 'POST',
        url: '/trainer/training-templates/batch-delete',
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
        url: '/trainer/training-templates/batch-delete',
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
        url: '/trainer/training-templates/batch-delete',
        payload: { ids: ['00000000-0000-0000-0000-000000000001'] },
      });

      expect(response.statusCode).toBe(401);
    });
  });
});
