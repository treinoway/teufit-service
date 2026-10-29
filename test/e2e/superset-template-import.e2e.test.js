import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { createBisetHarness } from '../helpers/biset-e2e.js';
import { provisionTrainerPlan } from '../helpers/platform-plan.js';
import { prisma } from '../../src/db.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const ROUND_REST = 75;
const UPDATED_REST = 30;

e2eDescribe('e2e: supersetRestInterval on templates and imports', () => {
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

  async function setupTrainer() {
    const trainer = await h.createTrainer();
    await provisionTrainerPlan(trainer.trainerId);
    return trainer;
  }

  function auth(token) {
    return { authorization: `Bearer ${token}` };
  }

  async function createExerciseTemplate(token, name) {
    const response = await app.inject({
      method: 'POST',
      url: '/trainer/exercise-templates',
      headers: auth(token),
      payload: { name, type: 'strength' },
    });
    expect(response.statusCode).toBe(201);
    return response.json();
  }

  // why: setup shared by all cases — training template with [A, B] grouped (ROUND_REST) and [C] loose.
  async function createGroupedTrainingTemplate(token) {
    const groupId = randomUUID();
    const [a, b, c] = [
      await createExerciseTemplate(token, 'A'),
      await createExerciseTemplate(token, 'B'),
      await createExerciseTemplate(token, 'C'),
    ];
    const response = await app.inject({
      method: 'POST',
      url: '/trainer/training-templates',
      headers: auth(token),
      payload: {
        name: 'Grouped',
        category: 'strength',
        exerciseTemplates: [
          { exerciseTemplateId: a.id, order: 0, sets: 3, supersetGroupId: groupId, supersetOrder: 0, supersetRestInterval: ROUND_REST },
          { exerciseTemplateId: b.id, order: 1, sets: 3, supersetGroupId: groupId, supersetOrder: 1, supersetRestInterval: ROUND_REST },
          { exerciseTemplateId: c.id, order: 2, sets: 3 },
        ],
      },
    });
    expect(response.statusCode).toBe(201);
    return { template: response.json(), groupId, exerciseTemplates: { a, b, c } };
  }

  async function exercisesOf(trainingId) {
    return prisma.exercise.findMany({ where: { trainingId }, orderBy: { order: 'asc' } });
  }

  describe('training template junction passthrough (criterion 10)', () => {
    it('POST /trainer/training-templates returns supersetRestInterval on junction rows', async () => {
      const trainer = await setupTrainer();

      const { template, groupId } = await createGroupedTrainingTemplate(trainer.accessToken);

      const junctions = template.trainingTemplateExerciseTemplates;
      expect(junctions[0]).toMatchObject({ supersetGroupId: groupId, supersetRestInterval: ROUND_REST });
      expect(junctions[1]).toMatchObject({ supersetGroupId: groupId, supersetRestInterval: ROUND_REST });
      expect(junctions[2]).toHaveProperty('supersetRestInterval', null);
    });

    it('GET /trainer/training-templates/:id returns the persisted supersetRestInterval', async () => {
      const trainer = await setupTrainer();
      const { template } = await createGroupedTrainingTemplate(trainer.accessToken);

      const response = await app.inject({
        method: 'GET',
        url: `/trainer/training-templates/${template.id}`,
        headers: auth(trainer.accessToken),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().trainingTemplateExerciseTemplates[0].supersetRestInterval).toBe(ROUND_REST);
    });

    it('POST /trainer/training-templates/:id/exercises accepts supersetRestInterval', async () => {
      const trainer = await setupTrainer();
      const { template } = await createGroupedTrainingTemplate(trainer.accessToken);

      const response = await app.inject({
        method: 'POST',
        url: `/trainer/training-templates/${template.id}/exercises`,
        headers: auth(trainer.accessToken),
        payload: {
          name: 'Ad hoc',
          type: 'strength',
          supersetGroupId: randomUUID(),
          supersetOrder: 0,
          supersetRestInterval: UPDATED_REST,
        },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().supersetRestInterval).toBe(UPDATED_REST);
    });

    it('POST /trainer/training-templates/:id/exercises/from-template accepts supersetRestInterval', async () => {
      const trainer = await setupTrainer();
      const { template } = await createGroupedTrainingTemplate(trainer.accessToken);
      const library = await createExerciseTemplate(trainer.accessToken, 'Library');

      const response = await app.inject({
        method: 'POST',
        url: `/trainer/training-templates/${template.id}/exercises/from-template`,
        headers: auth(trainer.accessToken),
        payload: {
          exerciseTemplateId: library.id,
          supersetGroupId: randomUUID(),
          supersetOrder: 0,
          supersetRestInterval: UPDATED_REST,
        },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().supersetRestInterval).toBe(UPDATED_REST);
    });

    it('PATCH /trainer/training-templates/:id/exercises/:exerciseId updates and clears supersetRestInterval', async () => {
      const trainer = await setupTrainer();
      const { template } = await createGroupedTrainingTemplate(trainer.accessToken);
      const junctionId = template.trainingTemplateExerciseTemplates[0].id;
      const patch = (payload) => app.inject({
        method: 'PATCH',
        url: `/trainer/training-templates/${template.id}/exercises/${junctionId}`,
        headers: auth(trainer.accessToken),
        payload,
      });

      const updated = await patch({ supersetRestInterval: UPDATED_REST });
      const cleared = await patch({ supersetRestInterval: null });

      expect(updated.statusCode).toBe(200);
      expect(updated.json().supersetRestInterval).toBe(UPDATED_REST);
      expect(cleared.json().supersetRestInterval).toBeNull();
    });

    it('rejects a negative supersetRestInterval with validation.failed', async () => {
      const trainer = await setupTrainer();
      const { template } = await createGroupedTrainingTemplate(trainer.accessToken);
      const junctionId = template.trainingTemplateExerciseTemplates[0].id;

      const response = await app.inject({
        method: 'PATCH',
        url: `/trainer/training-templates/${template.id}/exercises/${junctionId}`,
        headers: auth(trainer.accessToken),
        payload: { supersetRestInterval: -1 },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });
  });

  describe('POST /trainer/trainings/from-template (criterion 8)', () => {
    async function importTraining(trainer, protocolId, templateId) {
      const response = await app.inject({
        method: 'POST',
        url: '/trainer/trainings/from-template',
        headers: auth(trainer.accessToken),
        payload: { protocolId, templateId },
      });
      expect(response.statusCode).toBe(201);
      return response.json();
    }

    it('preserves grouping, supersetOrder and supersetRestInterval with a fresh group id', async () => {
      const ctx = await h.setupTraining();
      await provisionTrainerPlan(ctx.trainer.trainerId);
      const { template, groupId } = await createGroupedTrainingTemplate(ctx.trainer.accessToken);

      const imported = await importTraining(ctx.trainer, ctx.protocolId, template.id);

      const rows = await exercisesOf(imported.id);
      expect(rows.map((r) => [r.supersetOrder, r.supersetRestInterval])).toEqual([[0, ROUND_REST], [1, ROUND_REST], [0, null]]);
      expect(rows[0].supersetGroupId).toBeTruthy();
      expect(rows[0].supersetGroupId).not.toBe(groupId);
      expect(rows[1].supersetGroupId).toBe(rows[0].supersetGroupId);
      expect(rows[2].supersetGroupId).toBeNull();
    });

    it('gives each import its own group id', async () => {
      const ctx = await h.setupTraining();
      await provisionTrainerPlan(ctx.trainer.trainerId);
      const { template } = await createGroupedTrainingTemplate(ctx.trainer.accessToken);

      const first = await importTraining(ctx.trainer, ctx.protocolId, template.id);
      const second = await importTraining(ctx.trainer, ctx.protocolId, template.id);

      const [firstRows, secondRows] = [await exercisesOf(first.id), await exercisesOf(second.id)];
      expect(firstRows[0].supersetGroupId).not.toBe(secondRows[0].supersetGroupId);
    });
  });

  describe('POST /trainer/protocols/import-from-template (criterion 8)', () => {
    it('preserves grouping and supersetRestInterval with a fresh group id per imported training', async () => {
      const trainer = await setupTrainer();
      const student = await h.createStudent();
      await h.linkStudent(trainer.trainerId, student.userId);
      const { template, groupId } = await createGroupedTrainingTemplate(trainer.accessToken);
      const protocolTemplate = await app.inject({
        method: 'POST',
        url: '/trainer/protocol-templates',
        headers: auth(trainer.accessToken),
        payload: {
          name: 'Protocol Template',
          trainings: [
            { trainingTemplateId: template.id, weekDay: 'monday', order: 0 },
            { trainingTemplateId: template.id, weekDay: 'wednesday', order: 1 },
          ],
        },
      });
      expect(protocolTemplate.statusCode).toBe(201);

      const response = await app.inject({
        method: 'POST',
        url: '/trainer/protocols/import-from-template',
        headers: auth(trainer.accessToken),
        payload: { templateId: protocolTemplate.json().id, assigneeId: student.userId, startDate: '2026-03-01' },
      });

      expect(response.statusCode).toBe(201);
      const [first, second] = response.json().trainings;
      const [firstRows, secondRows] = [await exercisesOf(first.id), await exercisesOf(second.id)];
      expect(firstRows.map((r) => [r.supersetOrder, r.supersetRestInterval])).toEqual([[0, ROUND_REST], [1, ROUND_REST], [0, null]]);
      expect(firstRows[0].supersetGroupId).toBeTruthy();
      expect(firstRows[0].supersetGroupId).not.toBe(groupId);
      expect(firstRows[1].supersetGroupId).toBe(firstRows[0].supersetGroupId);
      expect(firstRows[2].supersetGroupId).toBeNull();
      expect(secondRows[0].supersetGroupId).not.toBe(firstRows[0].supersetGroupId);
    });
  });
});
