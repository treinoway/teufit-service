import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { signupVerified } from '../helpers/signup-user.js';
import { linkStudentByInvite } from '../helpers/link-student.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

e2eDescribe('e2e: POST /trainer/protocols/with-trainings', () => {
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

  // ─── Helpers ──────────────────────────────────────────────────────────────

  async function createTrainerWithToken() {
    const email = `e2e+trainer-${Date.now()}@example.com`;
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

    return { userId, accessToken: trainerToken, email };
  }

  async function createStudentWithToken() {
    const email = `e2e+student-${Date.now()}@example.com`;
    const password = 'StrongPassw0rd!';

    const signupResponse = await signupVerified(app, {
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password },
    });
    expect(signupResponse.statusCode).toBe(201);
    const { user: { id: userId }, token: { accessToken } } = signupResponse.json();

    await app.inject({
      method: 'PATCH',
      url: '/me/profile',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { firstName: 'Jane', lastName: 'Doe' },
    });

    return { userId, accessToken, email };
  }

  /**
   * Links the student to the trainer so assertStudentActiveOnPlan passes.
   */
  async function linkStudentToTrainer(trainerToken, studentEmail) {
    await linkStudentByInvite(app, { trainerToken, email: studentEmail });
  }

  function makeMinimalPayload(assigneeId) {
    return {
      assigneeId,
      name: 'Protocolo Bulk',
      startDate: '2026-01-01',
      trainings: [],
    };
  }

  function makeFullPayload(assigneeId) {
    return {
      assigneeId,
      name: 'Protocolo Completo',
      description: 'Protocolo de força',
      status: 'active',
      startDate: '2026-01-01',
      expirationDate: '2026-06-30',
      genderOrdination: 'male',
      trainingLevel: 'intermediate',
      type: 'strength',
      trainings: [
        {
          name: 'Treino A - Peito',
          description: 'Foco em peito',
          category: 'strength',
          bodySegment: 'upper',
          weekDay: 'monday',
          order: 0,
          exercises: [
            {
              name: 'Supino Reto',
              type: 'strength',
              order: 0,
              sets: 4,
              prescriptionMode: 'reps',
              repetitions: { min: 8, max: 12 },
              hasLoad: true,
              suggestedLoad: 60,
              restInterval: 90,
              notes: 'Descer até 90 graus',
            },
            {
              name: 'Crucifixo',
              type: 'strength',
              order: 1,
              sets: 3,
              prescriptionMode: 'reps',
              repetitions: { min: 12, max: 15 },
              hasLoad: true,
            },
          ],
        },
        {
          name: 'Treino B - Cardio',
          category: 'cardio',
          order: 1,
          exercises: [
            {
              name: 'Esteira',
              type: 'cardio',
              order: 0,
              sets: 1,
              prescriptionMode: 'duration',
              duration: 1800,
              intensity: 'moderate',
            },
          ],
        },
      ],
    };
  }

  // ─── Happy paths ──────────────────────────────────────────────────────────

  describe('happy path', () => {
    it('creates protocol with empty trainings and returns 201', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, email: studentEmail } = await createStudentWithToken();
      await linkStudentToTrainer(trainerToken, studentEmail);

      const response = await app.inject({
        method: 'POST',
        url: '/trainer/protocols/with-trainings',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: makeMinimalPayload(studentId),
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body).toHaveProperty('id');
      expect(body).toHaveProperty('assigneeId', studentId);
      expect(body).toHaveProperty('name', 'Protocolo Bulk');
      expect(body).toHaveProperty('status', 'active');
      expect(body).toHaveProperty('startDate', '2026-01-01');
      expect(body.trainings).toHaveLength(0);
    });

    it('creates protocol with trainings and exercises, returns trainings list', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, email: studentEmail } = await createStudentWithToken();
      await linkStudentToTrainer(trainerToken, studentEmail);

      const response = await app.inject({
        method: 'POST',
        url: '/trainer/protocols/with-trainings',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: makeFullPayload(studentId),
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();

      expect(body.trainings).toHaveLength(2);
      expect(body.trainings[0]).toMatchObject({ name: 'Treino A - Peito', order: 0 });
      expect(body.trainings[1]).toMatchObject({ name: 'Treino B - Cardio', order: 1 });
    });

    it('returns protocol with assignee info', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, email: studentEmail } = await createStudentWithToken();
      await linkStudentToTrainer(trainerToken, studentEmail);

      const response = await app.inject({
        method: 'POST',
        url: '/trainer/protocols/with-trainings',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: makeMinimalPayload(studentId),
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.assignee).toMatchObject({ id: studentId, firstName: 'Jane', lastName: 'Doe' });
      expect(body.assignee).toHaveProperty('avatarUrl');
    });

    it('returns estimatedDurationSeconds > 0 for training with exercises', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, email: studentEmail } = await createStudentWithToken();
      await linkStudentToTrainer(trainerToken, studentEmail);

      const response = await app.inject({
        method: 'POST',
        url: '/trainer/protocols/with-trainings',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: makeFullPayload(studentId),
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      const strengthTraining = body.trainings.find((t) => t.name === 'Treino A - Peito');
      expect(strengthTraining.estimatedDurationSeconds).toBeGreaterThan(0);
    });

    it('sets estimatedDurationSeconds = 0 for training with empty exercises', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, email: studentEmail } = await createStudentWithToken();
      await linkStudentToTrainer(trainerToken, studentEmail);

      const response = await app.inject({
        method: 'POST',
        url: '/trainer/protocols/with-trainings',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: {
          ...makeMinimalPayload(studentId),
          trainings: [{ name: 'Treino Vazio', category: 'rest', order: 0, exercises: [] }],
        },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.trainings[0].estimatedDurationSeconds).toBe(0);
    });

    it('returns startDate as YYYY-MM-DD string', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, email: studentEmail } = await createStudentWithToken();
      await linkStudentToTrainer(trainerToken, studentEmail);

      const response = await app.inject({
        method: 'POST',
        url: '/trainer/protocols/with-trainings',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: makeMinimalPayload(studentId),
      });

      const body = response.json();
      expect(body.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('returns expirationDate as YYYY-MM-DD string when provided', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, email: studentEmail } = await createStudentWithToken();
      await linkStudentToTrainer(trainerToken, studentEmail);

      const response = await app.inject({
        method: 'POST',
        url: '/trainer/protocols/with-trainings',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: makeFullPayload(studentId),
      });

      const body = response.json();
      expect(body.expirationDate).toBe('2026-06-30');
    });

    it('includes i18n label siblings (statusLabel, trainingLevelLabel)', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, email: studentEmail } = await createStudentWithToken();
      await linkStudentToTrainer(trainerToken, studentEmail);

      const response = await app.inject({
        method: 'POST',
        url: '/trainer/protocols/with-trainings',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: makeFullPayload(studentId),
      });

      const body = response.json();
      expect(body).toHaveProperty('statusLabel');
      expect(body).toHaveProperty('trainingLevelLabel');
    });
  });

  // ─── Authentication & authorization ───────────────────────────────────────

  describe('authentication and authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      const { userId: studentId } = await createStudentWithToken();

      const response = await app.inject({
        method: 'POST',
        url: '/trainer/protocols/with-trainings',
        payload: makeMinimalPayload(studentId),
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        error: expect.any(String),
        messageCode: expect.any(String),
        message: expect.any(String),
      });
    });

    it('returns 403 when authenticated as STUDENT role', async () => {
      const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();

      const response = await app.inject({
        method: 'POST',
        url: '/trainer/protocols/with-trainings',
        headers: { authorization: `Bearer ${studentToken}` },
        payload: makeMinimalPayload(studentId),
      });

      expect(response.statusCode).toBe(403);
    });
  });

  // ─── Not found errors ────────────────────────────────────────────────────

  describe('not found errors', () => {
    it('returns 404 when assigneeId does not exist', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const fakeAssigneeId = '00000000-0000-0000-0000-000000000001';

      const response = await app.inject({
        method: 'POST',
        url: '/trainer/protocols/with-trainings',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: makeMinimalPayload(fakeAssigneeId),
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({
        error: expect.any(String),
        messageCode: expect.any(String),
        message: expect.any(String),
      });
    });
  });

  // ─── Validation errors ───────────────────────────────────────────────────

  describe('validation errors', () => {
    it('returns 400 when name is missing', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, email: studentEmail } = await createStudentWithToken();
      await linkStudentToTrainer(trainerToken, studentEmail);

      const response = await app.inject({
        method: 'POST',
        url: '/trainer/protocols/with-trainings',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { assigneeId: studentId, startDate: '2026-01-01', trainings: [] },
      });

      expect(response.statusCode).toBe(400);
    });

    it('returns 400 when startDate is missing', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, email: studentEmail } = await createStudentWithToken();
      await linkStudentToTrainer(trainerToken, studentEmail);

      const response = await app.inject({
        method: 'POST',
        url: '/trainer/protocols/with-trainings',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { assigneeId: studentId, name: 'Test', trainings: [] },
      });

      expect(response.statusCode).toBe(400);
    });

    it('returns 400 when training is missing required "category"', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, email: studentEmail } = await createStudentWithToken();
      await linkStudentToTrainer(trainerToken, studentEmail);

      const response = await app.inject({
        method: 'POST',
        url: '/trainer/protocols/with-trainings',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: {
          ...makeMinimalPayload(studentId),
          trainings: [{ name: 'Treino', order: 0, exercises: [] }], // missing category
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('returns 400 when exercise is missing required "type"', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, email: studentEmail } = await createStudentWithToken();
      await linkStudentToTrainer(trainerToken, studentEmail);

      const response = await app.inject({
        method: 'POST',
        url: '/trainer/protocols/with-trainings',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: {
          ...makeMinimalPayload(studentId),
          trainings: [
            {
              name: 'Treino',
              category: 'strength',
              order: 0,
              exercises: [{ name: 'Squat', order: 0 }], // missing type
            },
          ],
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('silently strips unknown fields from the body (removeAdditional default)', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, email: studentEmail } = await createStudentWithToken();
      await linkStudentToTrainer(trainerToken, studentEmail);

      const response = await app.inject({
        method: 'POST',
        url: '/trainer/protocols/with-trainings',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: {
          ...makeMinimalPayload(studentId),
          unknownField: 'should be stripped',
        },
      });

      // Fastify's schema validation strips additionalProperties silently
      // (removeAdditional: true default) — unknown keys are ignored, not 400'd.
      // Same documented behavior as exercise.e2e.test.js.
      expect(response.statusCode).toBe(201);
      expect(response.json()).not.toHaveProperty('unknownField');
    });

    it('returns 400 for invalid status enum value', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, email: studentEmail } = await createStudentWithToken();
      await linkStudentToTrainer(trainerToken, studentEmail);

      const response = await app.inject({
        method: 'POST',
        url: '/trainer/protocols/with-trainings',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { ...makeMinimalPayload(studentId), status: 'invalid_status' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('returns 400 for invalid exercise type enum value', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, email: studentEmail } = await createStudentWithToken();
      await linkStudentToTrainer(trainerToken, studentEmail);

      const response = await app.inject({
        method: 'POST',
        url: '/trainer/protocols/with-trainings',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: {
          ...makeMinimalPayload(studentId),
          trainings: [
            {
              name: 'Treino',
              category: 'strength',
              order: 0,
              exercises: [{ name: 'Squat', type: 'yoga', order: 0 }],
            },
          ],
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  // ─── idempotency / result consistency ─────────────────────────────────────

  describe('result consistency', () => {
    it('created protocol is retrievable via GET /trainer/protocols/:id', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, email: studentEmail } = await createStudentWithToken();
      await linkStudentToTrainer(trainerToken, studentEmail);

      const createResponse = await app.inject({
        method: 'POST',
        url: '/trainer/protocols/with-trainings',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: makeFullPayload(studentId),
      });
      expect(createResponse.statusCode).toBe(201);
      const { id: protocolId } = createResponse.json();

      const getResponse = await app.inject({
        method: 'GET',
        url: `/trainer/protocols/${protocolId}`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(getResponse.statusCode).toBe(200);
      const getBody = getResponse.json();
      expect(getBody.id).toBe(protocolId);
      expect(getBody.trainings).toHaveLength(2);
    });

    it('two sequential calls create two independent protocols', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, email: studentEmail } = await createStudentWithToken();
      await linkStudentToTrainer(trainerToken, studentEmail);

      const payload = makeMinimalPayload(studentId);

      const r1 = await app.inject({
        method: 'POST',
        url: '/trainer/protocols/with-trainings',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload,
      });
      const r2 = await app.inject({
        method: 'POST',
        url: '/trainer/protocols/with-trainings',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload,
      });

      expect(r1.statusCode).toBe(201);
      expect(r2.statusCode).toBe(201);
      expect(r1.json().id).not.toBe(r2.json().id);
    });
  });
});
