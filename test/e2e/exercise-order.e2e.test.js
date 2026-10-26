import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { prisma } from '../../src/db.js';
import { signupVerified } from '../helpers/signup-user.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const CONCURRENT_REQUESTS = 5;
const PASSWORD = 'StrongPassw0rd!';

e2eDescribe('e2e: exercise ordering', () => {
  let app;
  let counter = 0;

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

  async function signup(prefix) {
    counter += 1;
    const response = await signupVerified(app, {
      method: 'POST',
      url: '/auth/signup',
      payload: { email: `e2e+${prefix}-${Date.now()}-${counter}@example.com`, password: PASSWORD },
    });
    expect(response.statusCode).toBe(201);
    return response.json();
  }

  async function createTrainerWithToken() {
    const { token: { accessToken } } = await signup('order-trainer');
    const response = await app.inject({
      method: 'PATCH',
      url: '/become-trainer',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(response.statusCode).toBe(200);
    return { accessToken: response.json().token.accessToken };
  }

  async function createTrainingTemplate(accessToken) {
    const response = await app.inject({
      method: 'POST',
      url: '/trainer/training-templates',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: 'Leg Day', category: 'strength' },
    });
    expect(response.statusCode).toBe(201);
    return response.json();
  }

  async function createExerciseTemplate(accessToken, name) {
    const response = await app.inject({
      method: 'POST',
      url: '/trainer/exercise-templates',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name, type: 'strength' },
    });
    expect(response.statusCode).toBe(201);
    return response.json();
  }

  const expectedConsecutiveOrders = Array.from({ length: CONCURRENT_REQUESTS }, (_, i) => i);

  describe('concurrent appends to a training template (no explicit order)', () => {
    it('assigns unique consecutive orders to concurrent POST .../exercises/from-template', async () => {
      const { accessToken } = await createTrainerWithToken();
      const template = await createTrainingTemplate(accessToken);
      const library = await Promise.all(
        expectedConsecutiveOrders.map((i) => createExerciseTemplate(accessToken, `Library ${i}`)),
      );

      const responses = await Promise.all(
        library.map((exerciseTemplate) =>
          app.inject({
            method: 'POST',
            url: `/trainer/training-templates/${template.id}/exercises/from-template`,
            headers: { authorization: `Bearer ${accessToken}` },
            payload: { exerciseTemplateId: exerciseTemplate.id },
          }),
        ),
      );

      expect(responses.map((r) => r.statusCode)).toEqual(Array(CONCURRENT_REQUESTS).fill(201));
      const rows = await prisma.trainingTemplateExerciseTemplate.findMany({
        where: { trainingTemplateId: template.id },
        select: { order: true },
      });
      expect(rows.map((r) => r.order).sort((a, b) => a - b)).toEqual(expectedConsecutiveOrders);
    });

    it('assigns unique consecutive orders to concurrent POST .../exercises', async () => {
      const { accessToken } = await createTrainerWithToken();
      const template = await createTrainingTemplate(accessToken);

      const responses = await Promise.all(
        expectedConsecutiveOrders.map((i) =>
          app.inject({
            method: 'POST',
            url: `/trainer/training-templates/${template.id}/exercises`,
            headers: { authorization: `Bearer ${accessToken}` },
            payload: { name: `Ad-hoc ${i}`, type: 'strength' },
          }),
        ),
      );

      expect(responses.map((r) => r.statusCode)).toEqual(Array(CONCURRENT_REQUESTS).fill(201));
      expect(responses.map((r) => r.json().order).sort((a, b) => a - b)).toEqual(expectedConsecutiveOrders);
      const rows = await prisma.trainingTemplateExerciseTemplate.findMany({
        where: { trainingTemplateId: template.id },
        select: { order: true },
      });
      expect(rows.map((r) => r.order).sort((a, b) => a - b)).toEqual(expectedConsecutiveOrders);
    });
  });

  describe('GET /trainer/trainings/:trainingId/exercises with duplicated order', () => {
    it('returns exercises sharing an order in creation order', async () => {
      const { accessToken } = await createTrainerWithToken();
      const { user: { id: assigneeId } } = await signup('order-assignee');
      const trainer = await prisma.trainer.findFirst({ select: { id: true } });
      await prisma.trainerStudent.create({
        data: { trainerId: trainer.id, studentId: assigneeId, activeOnPlan: true },
      });
      const protocol = await app.inject({
        method: 'POST',
        url: '/trainer/protocols',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { assigneeId, name: 'Protocol', startDate: '2025-02-01' },
      });
      expect(protocol.statusCode).toBe(201);
      const training = await app.inject({
        method: 'POST',
        url: `/trainer/protocols/${protocol.json().id}/trainings`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { name: 'Chest Day', category: 'strength' },
      });
      expect(training.statusCode).toBe(201);
      const trainingId = training.json().id;

      // why: insert the chronologically later row first so physical order differs from creation order
      const sharedOrder = 0;
      const rows = [
        { name: 'Created third', createdAt: new Date('2025-01-03T00:00:00Z') },
        { name: 'Created first', createdAt: new Date('2025-01-01T00:00:00Z') },
        { name: 'Created second', createdAt: new Date('2025-01-02T00:00:00Z') },
      ];
      for (const row of rows) {
        await prisma.exercise.create({
          data: { trainingId, type: 'strength', order: sharedOrder, ...row },
        });
      }

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await app.inject({
          method: 'GET',
          url: `/trainer/trainings/${trainingId}/exercises`,
          headers: { authorization: `Bearer ${accessToken}` },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().map((e) => e.name)).toEqual(['Created first', 'Created second', 'Created third']);
      }
    });
  });
});
