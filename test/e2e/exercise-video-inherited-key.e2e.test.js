import 'dotenv/config';
import crypto from 'node:crypto';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { prisma } from '../../src/db.js';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { createBisetHarness } from '../helpers/biset-e2e.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const KEY_PREFIX = 'exercise-videos/';
const INVALID_KEY_MESSAGE_CODE = 'exerciseVideo.invalidFileKey';

e2eDescribe('e2e: exercise video key inherited from visible templates', () => {
  let app;
  let h;

  beforeAll(async () => {
    app = await setupApp();
    h = createBisetHarness(app);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  function auth(token) {
    return { authorization: `Bearer ${token}` };
  }

  function foreignKey(ownerTrainerId) {
    return `${KEY_PREFIX}${ownerTrainerId}/${crypto.randomUUID()}.mp4`;
  }

  function seedTemplate(ownerTrainerId, key, overrides = {}) {
    return prisma.exerciseTemplate.create({
      data: { trainerId: ownerTrainerId, name: 'Shared', type: 'strength', videoFileKey: key, isPublic: true, ...overrides },
    });
  }

  function expectInvalidKeyContract(response) {
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: expect.any(String),
      messageCode: INVALID_KEY_MESSAGE_CODE,
      message: expect.any(String),
    });
    expect(response.json()).toHaveProperty('details');
  }

  function postExercise(token, trainingId, payload) {
    return app.inject({
      method: 'POST',
      url: `/trainer/trainings/${trainingId}/exercises`,
      headers: auth(token),
      payload: { name: 'Exercise', type: 'strength', sets: 3, ...payload },
    });
  }

  function patchExercise(token, id, payload) {
    return app.inject({ method: 'PATCH', url: `/trainer/exercises/${id}`, headers: auth(token), payload });
  }

  async function setupWithPublicForeignTemplate() {
    const ctx = await h.setupTraining();
    const other = await h.createTrainer();
    const key = foreignKey(other.trainerId);
    const template = await seedTemplate(other.trainerId, key);
    return { ...ctx, other, key, template };
  }

  describe('POST /trainer/exercises/from-template', () => {
    it('should accept the key of another trainer public template', async () => {
      const { trainer, trainingId, key, template } = await setupWithPublicForeignTemplate();

      const response = await app.inject({
        method: 'POST',
        url: '/trainer/exercises/from-template',
        headers: auth(trainer.accessToken),
        payload: { trainingId, templateId: template.id, sets: 3, videoFileKey: key },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toHaveProperty('videoFileKey', key);
    });
  });

  describe('POST /trainer/protocols/with-trainings', () => {
    function postBulk(trainer, studentId, exercises) {
      return app.inject({
        method: 'POST',
        url: '/trainer/protocols/with-trainings',
        headers: auth(trainer.accessToken),
        payload: {
          assigneeId: studentId,
          name: 'Bulk',
          startDate: '2026-01-01',
          trainings: [{ name: 'Day A', category: 'strength', order: 0, exercises }],
        },
      });
    }

    it('should accept the resent key on an exercise and on a substitute referencing the public template', async () => {
      const { trainer, student, key, template } = await setupWithPublicForeignTemplate();

      const response = await postBulk(trainer, student.userId, [{
        name: 'Principal',
        type: 'strength',
        order: 0,
        exerciseTemplateId: template.id,
        videoFileKey: key,
        substitutes: [{ name: 'Sub', type: 'strength', exerciseTemplateId: template.id, videoFileKey: key }],
      }]);

      expect(response.statusCode).toBe(201);
      const stored = await prisma.exercise.findMany({
        where: { trainingId: response.json().trainings[0].id },
        select: { videoFileKey: true },
      });
      expect(stored.map((row) => row.videoFileKey)).toEqual([key, key]);
    });

    it('should reject the foreign key when the exercise does not reference its template', async () => {
      const { trainer, student, key } = await setupWithPublicForeignTemplate();

      const response = await postBulk(trainer, student.userId, [
        { name: 'Principal', type: 'strength', order: 0, videoFileKey: key },
      ]);

      expectInvalidKeyContract(response);
    });

    it('should reject a foreign key that differs from the referenced template key', async () => {
      const { trainer, student, other, template } = await setupWithPublicForeignTemplate();

      const response = await postBulk(trainer, student.userId, [
        { name: 'Principal', type: 'strength', order: 0, exerciseTemplateId: template.id, videoFileKey: foreignKey(other.trainerId) },
      ]);

      expectInvalidKeyContract(response);
    });
  });

  describe('PATCH /trainer/exercises/:id', () => {
    async function createInheritedExercise(ctx) {
      const response = await app.inject({
        method: 'POST',
        url: '/trainer/exercises/from-template',
        headers: auth(ctx.trainer.accessToken),
        payload: { trainingId: ctx.trainingId, templateId: ctx.template.id, sets: 3 },
      });
      expect(response.statusCode).toBe(201);
      return response.json();
    }

    it('should accept the resent stored key even after its template became private and deleted', async () => {
      const ctx = await setupWithPublicForeignTemplate();
      const created = await createInheritedExercise(ctx);
      await prisma.exerciseTemplate.update({
        where: { id: ctx.template.id },
        data: { isPublic: false, deletedAt: new Date() },
      });

      const response = await patchExercise(ctx.trainer.accessToken, created.id, { videoFileKey: ctx.key, sets: 5 });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toHaveProperty('videoFileKey', ctx.key);
    });

    it('should reject a foreign key that is not the stored key, even if a public template carries it', async () => {
      const { trainer, trainingId, key } = await setupWithPublicForeignTemplate();
      const created = (await postExercise(trainer.accessToken, trainingId, {})).json();

      const response = await patchExercise(trainer.accessToken, created.id, { videoFileKey: key });

      expectInvalidKeyContract(response);
    });

    it('should reject a key that is only on another trainer private template', async () => {
      const { trainer, trainingId, other } = await setupWithPublicForeignTemplate();
      const privateKey = foreignKey(other.trainerId);
      await seedTemplate(other.trainerId, privateKey, { isPublic: false });
      const created = (await postExercise(trainer.accessToken, trainingId, {})).json();

      const response = await patchExercise(trainer.accessToken, created.id, { videoFileKey: privateKey });

      expectInvalidKeyContract(response);
    });

    it('should reject a key that is only on a soft-deleted public template', async () => {
      const { trainer, trainingId, other } = await setupWithPublicForeignTemplate();
      const deletedKey = foreignKey(other.trainerId);
      await seedTemplate(other.trainerId, deletedKey, { deletedAt: new Date() });
      const created = (await postExercise(trainer.accessToken, trainingId, {})).json();

      const response = await patchExercise(trainer.accessToken, created.id, { videoFileKey: deletedKey });

      expectInvalidKeyContract(response);
    });
  });

  describe('training templates', () => {
    function createTrainingTemplate(token, exerciseTemplates) {
      return app.inject({
        method: 'POST',
        url: '/trainer/training-templates',
        headers: auth(token),
        payload: { name: 'Leg Day', category: 'strength', exerciseTemplates },
      });
    }

    it('should accept the resent key in nested exerciseTemplates referencing the public template', async () => {
      const { trainer, key, template } = await setupWithPublicForeignTemplate();

      const response = await createTrainingTemplate(trainer.accessToken, [
        { exerciseTemplateId: template.id, videoFileKey: key },
      ]);

      expect(response.statusCode).toBe(201);
      expect(response.json().trainingTemplateExerciseTemplates[0]).toHaveProperty('videoFileKey', key);
    });

    it('should reject the foreign key in nested exerciseTemplates referencing a template without that key', async () => {
      const { trainer, key } = await setupWithPublicForeignTemplate();
      const own = (await app.inject({
        method: 'POST',
        url: '/trainer/exercise-templates',
        headers: auth(trainer.accessToken),
        payload: { name: 'Own', type: 'strength' },
      })).json();

      const response = await createTrainingTemplate(trainer.accessToken, [
        { exerciseTemplateId: own.id, videoFileKey: key },
      ]);

      expectInvalidKeyContract(response);
    });

    it('should accept the resent stored key on PATCH of a junction exercise', async () => {
      const { trainer, key, template } = await setupWithPublicForeignTemplate();
      const training = (await createTrainingTemplate(trainer.accessToken, [
        { exerciseTemplateId: template.id, videoFileKey: key },
      ])).json();
      const junction = training.trainingTemplateExerciseTemplates[0];

      const response = await app.inject({
        method: 'PATCH',
        url: `/trainer/training-templates/${training.id}/exercises/${junction.id}`,
        headers: auth(trainer.accessToken),
        payload: { videoFileKey: key, sets: 4 },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toHaveProperty('videoFileKey', key);
    });
  });
});
