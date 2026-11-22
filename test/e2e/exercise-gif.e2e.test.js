import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { prisma } from '../../src/db.js';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { signupVerified } from '../helpers/signup-user.js';
import { linkStudentByInvite } from '../helpers/link-student.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const GIF_URL = 'https://cdn.example.com/exercises/squat.gif';
const OTHER_GIF_URL = 'https://cdn.example.com/exercises/lunge.gif';
const INVALID_GIF_URL = 'ftp://cdn.example.com/squat.gif';
const PASSWORD = 'StrongPassw0rd!';

e2eDescribe('e2e: exercise gifUrl schema additions', () => {
  let app;
  let seq = 0;

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });


  async function createTrainerWithToken() {
    seq += 1;
    const signupResponse = await signupVerified(app, {
      method: 'POST',
      url: '/auth/signup',
      payload: { email: `e2e+gif-trainer-${Date.now()}-${seq}@example.com`, password: PASSWORD },
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

    const trainer = await prisma.trainer.findUnique({ where: { userId }, select: { id: true } });
    return { trainerId: trainer.id, accessToken: trainerToken };
  }

  async function createStudentWithToken() {
    seq += 1;
    const email = `e2e+gif-student-${Date.now()}-${seq}@example.com`;
    const signupResponse = await signupVerified(app, {
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password: PASSWORD },
    });
    expect(signupResponse.statusCode).toBe(201);
    const { user: { id: userId }, token: { accessToken } } = signupResponse.json();
    return { userId, accessToken, email };
  }

  function authHeader(token) {
    return { authorization: `Bearer ${token}` };
  }

  async function createExerciseTemplate(token, name = 'Barbell Squat') {
    const response = await app.inject({
      method: 'POST',
      url: '/trainer/exercise-templates',
      headers: authHeader(token),
      payload: { name, type: 'strength' },
    });
    expect(response.statusCode).toBe(201);
    return response.json();
  }

  async function createTrainingTemplate(token, payload) {
    const response = await app.inject({
      method: 'POST',
      url: '/trainer/training-templates',
      headers: authHeader(token),
      payload: { name: 'Leg Day', category: 'strength', ...payload },
    });
    expect(response.statusCode).toBe(201);
    return response.json();
  }

  function todayWeekday() {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' })
      .format(new Date())
      .toLowerCase();
  }


  describe('GET /my/workouts/today', () => {
    it('returns gifUrl as set value and null when absent on targetTraining exercises', async () => {
      const { trainerId } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
      await prisma.trainerStudent.create({ data: { trainerId, studentId } });

      const protocol = await prisma.trainingProtocol.create({
        data: {
          trainerId,
          assigneeId: studentId,
          name: 'GIF Protocol',
          status: 'active',
          startDate: new Date('2025-01-01'),
        },
      });
      const training = await prisma.training.create({
        data: {
          trainingProtocolId: protocol.id,
          name: 'Today Training',
          category: 'strength',
          weekDay: todayWeekday(),
          order: 0,
        },
      });
      await prisma.exercise.create({
        data: { trainingId: training.id, name: 'With GIF', type: 'strength', order: 0, gifUrl: GIF_URL },
      });
      await prisma.exercise.create({
        data: { trainingId: training.id, name: 'Without GIF', type: 'strength', order: 1 },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/my/workouts/today',
        headers: { ...authHeader(studentToken), 'app-language': 'en-US', 'app-timezone': 'UTC' },
      });

      expect(response.statusCode).toBe(200);
      const { exercises } = response.json().workouts[0].targetTraining;
      const byName = Object.fromEntries(exercises.map((e) => [e.name, e]));
      expect(byName['With GIF']).toHaveProperty('gifUrl', GIF_URL);
      expect(byName['Without GIF']).toHaveProperty('gifUrl', null);
    });
  });


  describe('PATCH /trainer/training-templates/:templateId/exercises/:exerciseId', () => {
    async function setupJunction() {
      const { accessToken } = await createTrainerWithToken();
      const exerciseTemplate = await createExerciseTemplate(accessToken);
      const template = await createTrainingTemplate(accessToken, {
        exerciseTemplates: [{ exerciseTemplateId: exerciseTemplate.id }],
      });
      const junction = template.trainingTemplateExerciseTemplates[0];
      return {
        accessToken,
        url: `/trainer/training-templates/${template.id}/exercises/${junction.id}`,
      };
    }

    it('sets gifUrl on the junction row', async () => {
      const { accessToken, url } = await setupJunction();

      const response = await app.inject({
        method: 'PATCH',
        url,
        headers: authHeader(accessToken),
        payload: { gifUrl: GIF_URL },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toHaveProperty('gifUrl', GIF_URL);
    });

    it('clears gifUrl when null is sent', async () => {
      const { accessToken, url } = await setupJunction();
      await app.inject({ method: 'PATCH', url, headers: authHeader(accessToken), payload: { gifUrl: GIF_URL } });

      const response = await app.inject({
        method: 'PATCH',
        url,
        headers: authHeader(accessToken),
        payload: { gifUrl: null },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toHaveProperty('gifUrl', null);
    });

    it('keeps gifUrl untouched when the key is omitted', async () => {
      const { accessToken, url } = await setupJunction();
      await app.inject({ method: 'PATCH', url, headers: authHeader(accessToken), payload: { gifUrl: GIF_URL } });

      const response = await app.inject({
        method: 'PATCH',
        url,
        headers: authHeader(accessToken),
        payload: { sets: 3 },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toHaveProperty('gifUrl', GIF_URL);
    });

    it('returns 400 VALIDATION_ERROR for a non-http(s) gifUrl', async () => {
      const { accessToken, url } = await setupJunction();

      const response = await app.inject({
        method: 'PATCH',
        url,
        headers: authHeader(accessToken),
        payload: { gifUrl: INVALID_GIF_URL },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: 'VALIDATION_ERROR',
        messageCode: 'validation.failed',
      });
    });
  });


  describe('POST /trainer/training-templates (bulk exerciseTemplates)', () => {
    it('persists and returns gifUrl on junction rows', async () => {
      const { accessToken } = await createTrainerWithToken();
      const exerciseTemplate = await createExerciseTemplate(accessToken);

      const template = await createTrainingTemplate(accessToken, {
        exerciseTemplates: [
          { exerciseTemplateId: exerciseTemplate.id, gifUrl: GIF_URL },
          { exerciseTemplateId: exerciseTemplate.id },
        ],
      });

      const junctions = template.trainingTemplateExerciseTemplates;
      expect(junctions.map((j) => j.gifUrl).sort()).toEqual([GIF_URL, null].sort());

      const stored = await prisma.trainingTemplateExerciseTemplate.findMany({
        where: { trainingTemplateId: template.id },
        select: { gifUrl: true },
      });
      expect(stored.map((j) => j.gifUrl).sort()).toEqual([GIF_URL, null].sort());
    });

    it('returns 400 VALIDATION_ERROR for an invalid gifUrl', async () => {
      const { accessToken } = await createTrainerWithToken();
      const exerciseTemplate = await createExerciseTemplate(accessToken);

      const response = await app.inject({
        method: 'POST',
        url: '/trainer/training-templates',
        headers: authHeader(accessToken),
        payload: {
          name: 'Leg Day',
          category: 'strength',
          exerciseTemplates: [{ exerciseTemplateId: exerciseTemplate.id, gifUrl: INVALID_GIF_URL }],
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });
  });

  describe('PATCH /trainer/training-templates/:id (bulk exerciseTemplates)', () => {
    it('persists and returns gifUrl on the replaced junction rows', async () => {
      const { accessToken } = await createTrainerWithToken();
      const exerciseTemplate = await createExerciseTemplate(accessToken);
      const template = await createTrainingTemplate(accessToken, {
        exerciseTemplates: [{ exerciseTemplateId: exerciseTemplate.id, gifUrl: GIF_URL }],
      });

      const response = await app.inject({
        method: 'PATCH',
        url: `/trainer/training-templates/${template.id}`,
        headers: authHeader(accessToken),
        payload: { exerciseTemplates: [{ exerciseTemplateId: exerciseTemplate.id, gifUrl: OTHER_GIF_URL }] },
      });

      expect(response.statusCode).toBe(200);
      const junctions = response.json().trainingTemplateExerciseTemplates;
      expect(junctions).toHaveLength(1);
      expect(junctions[0]).toHaveProperty('gifUrl', OTHER_GIF_URL);

      const stored = await prisma.trainingTemplateExerciseTemplate.findMany({
        where: { trainingTemplateId: template.id },
        select: { gifUrl: true },
      });
      expect(stored).toEqual([{ gifUrl: OTHER_GIF_URL }]);
    });

    it('returns 400 VALIDATION_ERROR for an invalid gifUrl', async () => {
      const { accessToken } = await createTrainerWithToken();
      const exerciseTemplate = await createExerciseTemplate(accessToken);
      const template = await createTrainingTemplate(accessToken, {});

      const response = await app.inject({
        method: 'PATCH',
        url: `/trainer/training-templates/${template.id}`,
        headers: authHeader(accessToken),
        payload: { exerciseTemplates: [{ exerciseTemplateId: exerciseTemplate.id, gifUrl: INVALID_GIF_URL }] },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });
  });


  describe('POST /trainer/protocols/with-trainings', () => {
    async function postProtocol(exercises) {
      const { accessToken } = await createTrainerWithToken();
      const { userId: studentId, email } = await createStudentWithToken();
      await linkStudentByInvite(app, { trainerToken: accessToken, email });

      return app.inject({
        method: 'POST',
        url: '/trainer/protocols/with-trainings',
        headers: authHeader(accessToken),
        payload: {
          assigneeId: studentId,
          name: 'GIF Bulk Protocol',
          startDate: '2026-01-01',
          trainings: [{ name: 'Treino A', category: 'strength', order: 0, exercises }],
        },
      });
    }

    it('persists nested exercise gifUrl (set and omitted)', async () => {
      const response = await postProtocol([
        { name: 'Agachamento', type: 'strength', order: 0, sets: 3, gifUrl: GIF_URL },
        { name: 'Afundo', type: 'strength', order: 1, sets: 3 },
      ]);

      expect(response.statusCode).toBe(201);
      const trainingId = response.json().trainings[0].id;
      const stored = await prisma.exercise.findMany({
        where: { trainingId },
        orderBy: { order: 'asc' },
        select: { name: true, gifUrl: true },
      });
      expect(stored).toEqual([
        { name: 'Agachamento', gifUrl: GIF_URL },
        { name: 'Afundo', gifUrl: null },
      ]);
    });

    it('returns 400 VALIDATION_ERROR for an invalid nested gifUrl', async () => {
      const response = await postProtocol([
        { name: 'Agachamento', type: 'strength', order: 0, sets: 3, gifUrl: INVALID_GIF_URL },
      ]);

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });
  });
});
