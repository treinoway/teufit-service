import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { bearer, createAdvancedTechniqueFixtures } from '../helpers/advanced-technique-e2e.js';
import { prisma } from '../../src/db.js';
import { BulkProtocolErrorCode, BulkProtocolMessageCode } from '../../src/constants/training.js';
import {
  AdvancedTechniqueErrorCode,
  AdvancedTechniqueMessageCode,
} from '../../src/constants/advanced-technique.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const MAX_TECHNIQUES = 5;

e2eDescribe('e2e: POST /trainer/protocols/with-trainings — substitute template and technique links', () => {
  let app;
  let fx;

  beforeAll(async () => {
    app = await setupApp();
    fx = createAdvancedTechniqueFixtures(app);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  async function setupActors() {
    const trainer = await fx.createTrainer();
    const student = await fx.createStudent();
    await fx.linkStudent(trainer.trainerId, student.userId);
    const a = await fx.createTechnique(trainer.accessToken, { name: 'A' });
    const b = await fx.createTechnique(trainer.accessToken, { name: 'B' });
    const c = await fx.createTechnique(trainer.accessToken, { name: 'C' });
    return { trainer, student, a, b, c };
  }

  function postBulk(trainer, studentId, exercises) {
    return app.inject({
      method: 'POST',
      url: '/trainer/protocols/with-trainings',
      headers: bearer(trainer.accessToken),
      payload: {
        assigneeId: studentId,
        name: 'Bulk',
        startDate: '2026-01-01',
        trainings: [{ name: 'Day A', category: 'strength', order: 0, exercises }],
      },
    });
  }

  function withSubstitute(substituteExtra = {}, principalExtra = {}) {
    return [{
      name: 'Principal',
      type: 'strength',
      order: 0,
      ...principalExtra,
      substitutes: [{ name: 'Sub', type: 'strength', ...substituteExtra }],
    }];
  }

  async function storedSubstitute(trainingId) {
    const row = await prisma.exercise.findFirst({
      where: { trainingId, substituteForExerciseId: { not: null } },
      include: { advancedTechniqueLinks: { orderBy: { order: 'asc' } } },
    });
    return row;
  }

  function linkedIds(row) {
    return row.advancedTechniqueLinks.map((link) => link.advancedTechniqueId);
  }

  function expectInvalidSelection(response) {
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: AdvancedTechniqueErrorCode.INVALID_SELECTION,
      messageCode: AdvancedTechniqueMessageCode.INVALID_SELECTION,
    });
  }

  function expectValidationFailed(response) {
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
  }

  async function protocolCount(trainer) {
    return prisma.trainingProtocol.count({ where: { trainerId: trainer.trainerId } });
  }

  describe('exerciseTemplateId', () => {
    it('stores the exerciseTemplateId on the substitute row', async () => {
      const { trainer, student } = await setupActors();
      const template = await fx.createExerciseTemplate(trainer.accessToken);

      const response = await postBulk(trainer, student.userId, withSubstitute({ exerciseTemplateId: template.id }));

      expect(response.statusCode).toBe(201);
      const sub = await storedSubstitute(response.json().trainings[0].id);
      expect(sub.exerciseTemplateId).toBe(template.id);
    });

    it('accepts a public template owned by another trainer', async () => {
      const { trainer, student } = await setupActors();
      const other = await fx.createTrainer();
      const template = await fx.createExerciseTemplate(other.accessToken);
      await prisma.exerciseTemplate.update({ where: { id: template.id }, data: { isPublic: true } });

      const response = await postBulk(trainer, student.userId, withSubstitute({ exerciseTemplateId: template.id }));

      expect(response.statusCode).toBe(201);
      expect((await storedSubstitute(response.json().trainings[0].id)).exerciseTemplateId).toBe(template.id);
    });

    it('rejects a private template of another trainer with 403 and persists nothing', async () => {
      const { trainer, student } = await setupActors();
      const other = await fx.createTrainer();
      const template = await fx.createExerciseTemplate(other.accessToken);

      const response = await postBulk(trainer, student.userId, withSubstitute({ exerciseTemplateId: template.id }));

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        error: BulkProtocolErrorCode.EXERCISE_TEMPLATE_NOT_OWNED,
        messageCode: BulkProtocolMessageCode.EXERCISE_TEMPLATE_NOT_OWNED,
      });
      expect(await protocolCount(trainer)).toBe(0);
    });

    it('rejects an unknown template id with 403 and persists nothing', async () => {
      const { trainer, student } = await setupActors();

      const response = await postBulk(trainer, student.userId, withSubstitute({ exerciseTemplateId: randomUUID() }));

      expect(response.statusCode).toBe(403);
      expect(response.json().error).toBe(BulkProtocolErrorCode.EXERCISE_TEMPLATE_NOT_OWNED);
      expect(await protocolCount(trainer)).toBe(0);
    });

    it('rejects a soft-deleted template with 403', async () => {
      const { trainer, student } = await setupActors();
      const template = await fx.createExerciseTemplate(trainer.accessToken);
      await prisma.exerciseTemplate.update({ where: { id: template.id }, data: { deletedAt: new Date() } });

      const response = await postBulk(trainer, student.userId, withSubstitute({ exerciseTemplateId: template.id }));

      expect(response.statusCode).toBe(403);
      expect(response.json().error).toBe(BulkProtocolErrorCode.EXERCISE_TEMPLATE_NOT_OWNED);
    });

    it('rejects a non-uuid exerciseTemplateId with validation.failed', async () => {
      const { trainer, student } = await setupActors();

      const response = await postBulk(trainer, student.userId, withSubstitute({ exerciseTemplateId: 'not-a-uuid' }));

      expectValidationFailed(response);
    });
  });

  describe('advancedTechniqueIds', () => {
    it('stores the techniques on the substitute in the order sent', async () => {
      const { trainer, student, a, b, c } = await setupActors();

      const response = await postBulk(trainer, student.userId, withSubstitute({ advancedTechniqueIds: [c.id, a.id, b.id] }));

      expect(response.statusCode).toBe(201);
      const sub = await storedSubstitute(response.json().trainings[0].id);
      expect(linkedIds(sub)).toEqual([c.id, a.id, b.id]);
      expect(sub.advancedTechniqueLinks.map((link) => link.order)).toEqual([0, 1, 2]);
    });

    it('does not link techniques to the principal when only the substitute carries them', async () => {
      const { trainer, student, a } = await setupActors();

      const response = await postBulk(trainer, student.userId, withSubstitute({ advancedTechniqueIds: [a.id] }));

      expect(response.statusCode).toBe(201);
      const principal = await prisma.exercise.findFirst({
        where: { trainingId: response.json().trainings[0].id, substituteForExerciseId: null },
        include: { advancedTechniqueLinks: true },
      });
      expect(principal.advancedTechniqueLinks).toEqual([]);
    });

    it('keeps principal and substitute technique lists independent', async () => {
      const { trainer, student, a, b } = await setupActors();

      const response = await postBulk(
        trainer,
        student.userId,
        withSubstitute({ advancedTechniqueIds: [b.id] }, { advancedTechniqueIds: [a.id] }),
      );

      expect(response.statusCode).toBe(201);
      const trainingId = response.json().trainings[0].id;
      const principal = await prisma.exercise.findFirst({
        where: { trainingId, substituteForExerciseId: null },
        include: { advancedTechniqueLinks: true },
      });
      expect(linkedIds(principal)).toEqual([a.id]);
      expect(linkedIds(await storedSubstitute(trainingId))).toEqual([b.id]);
    });

    it('accepts exactly the maximum of 5 techniques', async () => {
      const { trainer, student } = await setupActors();
      const ids = [];
      for (let i = 0; i < MAX_TECHNIQUES; i += 1) {
        ids.push((await fx.createTechnique(trainer.accessToken, { name: `T${i}` })).id);
      }

      const response = await postBulk(trainer, student.userId, withSubstitute({ advancedTechniqueIds: ids }));

      expect(response.statusCode).toBe(201);
      expect(linkedIds(await storedSubstitute(response.json().trainings[0].id))).toEqual(ids);
    });

    it('rejects more than 5 techniques with validation.failed', async () => {
      const { trainer, student } = await setupActors();
      const ids = [];
      for (let i = 0; i <= MAX_TECHNIQUES; i += 1) {
        ids.push((await fx.createTechnique(trainer.accessToken, { name: `T${i}` })).id);
      }

      const response = await postBulk(trainer, student.userId, withSubstitute({ advancedTechniqueIds: ids }));

      expectValidationFailed(response);
      expect(await protocolCount(trainer)).toBe(0);
    });

    it('rejects duplicate ids with validation.failed', async () => {
      const { trainer, student, a } = await setupActors();

      const response = await postBulk(trainer, student.userId, withSubstitute({ advancedTechniqueIds: [a.id, a.id] }));

      expectValidationFailed(response);
    });

    it('rejects a non-uuid id with validation.failed', async () => {
      const { trainer, student } = await setupActors();

      const response = await postBulk(trainer, student.userId, withSubstitute({ advancedTechniqueIds: ['nope'] }));

      expectValidationFailed(response);
    });

    it('rejects another trainer\'s technique with invalidSelection and persists nothing', async () => {
      const { trainer, student } = await setupActors();
      const other = await fx.createTrainer();
      const foreign = await fx.createTechnique(other.accessToken, { name: 'Foreign' });

      const response = await postBulk(trainer, student.userId, withSubstitute({ advancedTechniqueIds: [foreign.id] }));

      expectInvalidSelection(response);
      expect(await protocolCount(trainer)).toBe(0);
    });

    it('rejects an unknown technique id with invalidSelection', async () => {
      const { trainer, student } = await setupActors();

      const response = await postBulk(trainer, student.userId, withSubstitute({ advancedTechniqueIds: [randomUUID()] }));

      expectInvalidSelection(response);
    });

    it('rejects a soft-deleted technique with invalidSelection and persists nothing', async () => {
      const { trainer, student, a } = await setupActors();
      await fx.deleteTechnique(trainer.accessToken, a.id);

      const response = await postBulk(trainer, student.userId, withSubstitute({ advancedTechniqueIds: [a.id] }));

      expectInvalidSelection(response);
      expect(await protocolCount(trainer)).toBe(0);
    });

    it('rejects a valid principal when only its substitute has an invalid technique', async () => {
      const { trainer, student, a } = await setupActors();
      const other = await fx.createTrainer();
      const foreign = await fx.createTechnique(other.accessToken, { name: 'Foreign' });

      const response = await postBulk(
        trainer,
        student.userId,
        withSubstitute({ advancedTechniqueIds: [foreign.id] }, { advancedTechniqueIds: [a.id] }),
      );

      expectInvalidSelection(response);
      expect(await prisma.exercise.count({ where: { training: { trainingProtocol: { trainerId: trainer.trainerId } } } })).toBe(0);
    });
  });

  describe('template technique inheritance', () => {
    it('inherits the template techniques in order when ids are omitted', async () => {
      const { trainer, student, a, b } = await setupActors();
      const template = await fx.createExerciseTemplate(trainer.accessToken, { advancedTechniqueIds: [b.id, a.id] });

      const response = await postBulk(trainer, student.userId, withSubstitute({ exerciseTemplateId: template.id }));

      expect(response.statusCode).toBe(201);
      const sub = await storedSubstitute(response.json().trainings[0].id);
      expect(linkedIds(sub)).toEqual([b.id, a.id]);
      expect(sub.advancedTechniqueLinks.map((link) => link.order)).toEqual([0, 1]);
    });

    it('uses the sent list instead of inheriting when ids are present', async () => {
      const { trainer, student, a, b, c } = await setupActors();
      const template = await fx.createExerciseTemplate(trainer.accessToken, { advancedTechniqueIds: [a.id, b.id] });

      const response = await postBulk(
        trainer,
        student.userId,
        withSubstitute({ exerciseTemplateId: template.id, advancedTechniqueIds: [c.id] }),
      );

      expect(response.statusCode).toBe(201);
      expect(linkedIds(await storedSubstitute(response.json().trainings[0].id))).toEqual([c.id]);
    });

    it('does not inherit when an empty list is sent', async () => {
      const { trainer, student, a } = await setupActors();
      const template = await fx.createExerciseTemplate(trainer.accessToken, { advancedTechniqueIds: [a.id] });

      const response = await postBulk(
        trainer,
        student.userId,
        withSubstitute({ exerciseTemplateId: template.id, advancedTechniqueIds: [] }),
      );

      expect(response.statusCode).toBe(201);
      expect(linkedIds(await storedSubstitute(response.json().trainings[0].id))).toEqual([]);
    });

    it('links nothing when the template has no techniques and none are sent', async () => {
      const { trainer, student } = await setupActors();
      const template = await fx.createExerciseTemplate(trainer.accessToken);

      const response = await postBulk(trainer, student.userId, withSubstitute({ exerciseTemplateId: template.id }));

      expect(response.statusCode).toBe(201);
      expect(linkedIds(await storedSubstitute(response.json().trainings[0].id))).toEqual([]);
    });
  });

  describe('backward compatibility and remaining restrictions', () => {
    it('keeps a substitute without the new keys unlinked', async () => {
      const { trainer, student } = await setupActors();

      const response = await postBulk(trainer, student.userId, withSubstitute());

      expect(response.statusCode).toBe(201);
      const sub = await storedSubstitute(response.json().trainings[0].id);
      expect(sub.exerciseTemplateId).toBeNull();
      expect(sub.advancedTechniqueLinks).toEqual([]);
    });

    it('still rejects superset keys on a substitute', async () => {
      const { trainer, student } = await setupActors();

      const response = await postBulk(trainer, student.userId, withSubstitute({ supersetGroupId: randomUUID() }));

      expectValidationFailed(response);
    });

    it('still rejects nested substitutes on a substitute', async () => {
      const { trainer, student } = await setupActors();

      const response = await postBulk(
        trainer,
        student.userId,
        withSubstitute({ substitutes: [{ name: 'Deep', type: 'strength' }] }),
      );

      expectValidationFailed(response);
    });
  });
});
