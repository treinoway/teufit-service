import 'dotenv/config';
import crypto from 'node:crypto';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { prisma } from '../../src/db.js';
import { bearer, createAdvancedTechniqueFixtures, techniqueIds } from '../helpers/advanced-technique-e2e.js';
import {
  AdvancedTechniqueErrorCode,
  AdvancedTechniqueMessageCode,
} from '../../src/constants/advanced-technique.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const MAX_TECHNIQUES = 5;
const REF_KEYS = ['id', 'key', 'name', 'description', 'videoUrl', 'gifUrl', 'isDeleted', 'order'];

e2eDescribe('e2e: advanced techniques on exercises, templates and routines', () => {
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

  async function setup() {
    const trainer = await fx.createTrainer();
    const student = await fx.createStudent();
    const { protocolId, trainingId } = await fx.createProtocolAndTraining(trainer, student.userId);
    const a = await fx.createTechnique(trainer.accessToken, { name: 'Technique A' });
    const b = await fx.createTechnique(trainer.accessToken, { name: 'Technique B' });
    return { trainer, student, protocolId, trainingId, a, b };
  }

  function post(token, url, payload) {
    return app.inject({ method: 'POST', url, headers: bearer(token), payload });
  }

  function patch(token, url, payload) {
    return app.inject({ method: 'PATCH', url, headers: bearer(token), payload });
  }

  function get(token, url, headers = {}) {
    return app.inject({ method: 'GET', url, headers: { ...bearer(token), ...headers } });
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


  describe('POST /trainer/trainings/:trainingId/exercises', () => {
    const url = (trainingId) => `/trainer/trainings/${trainingId}/exercises`;
    const exercise = (extra = {}) => ({ name: 'Bench Press', type: 'strength', sets: 3, ...extra });

    it('should store the techniques in the order sent and return them ordered', async () => {
      const { trainer, trainingId, a, b } = await setup();

      const response = await post(trainer.accessToken, url(trainingId), exercise({ advancedTechniqueIds: [b.id, a.id] }));

      expect(response.statusCode).toBe(201);
      const { advancedTechniques } = response.json();
      expect(techniqueIds(advancedTechniques)).toEqual([b.id, a.id]);
      expect(advancedTechniques.map((t) => t.order)).toEqual([0, 1]);
    });

    it('should return each technique with id, key, name, description, videoUrl, gifUrl and order', async () => {
      const { trainer, trainingId } = await setup();
      const dropSet = await fx.systemTechniqueByKey('drop_set');
      const own = await fx.createTechnique(trainer.accessToken, {
        name: 'With media',
        videoUrl: 'https://youtu.be/abc',
        gifUrl: 'https://example.com/m.gif',
      });

      const response = await post(
        trainer.accessToken,
        url(trainingId),
        exercise({ advancedTechniqueIds: [dropSet.id, own.id] }),
      );

      const [system, mine] = response.json().advancedTechniques;
      expect(Object.keys(system).sort()).toEqual([...REF_KEYS].sort());
      expect(system).toMatchObject({ id: dropSet.id, key: 'drop_set', name: 'Drop set', order: 0 });
      expect(mine).toMatchObject({
        id: own.id,
        key: null,
        name: 'With media',
        videoUrl: 'https://youtu.be/abc',
        gifUrl: 'https://example.com/m.gif',
        order: 1,
      });
    });

    it('should accept system techniques mixed with own ones', async () => {
      const { trainer, trainingId, a } = await setup();
      const restPause = await fx.systemTechniqueByKey('rest_pause');

      const response = await post(
        trainer.accessToken,
        url(trainingId),
        exercise({ advancedTechniqueIds: [a.id, restPause.id] }),
      );

      expect(response.statusCode).toBe(201);
      expect(techniqueIds(response.json().advancedTechniques)).toEqual([a.id, restPause.id]);
    });

    it('should persist link rows with the order (index) in the database', async () => {
      const { trainer, trainingId, a, b } = await setup();

      const { id } = (await post(trainer.accessToken, url(trainingId), exercise({ advancedTechniqueIds: [b.id, a.id] }))).json();

      const links = await prisma.exerciseAdvancedTechnique.findMany({ where: { exerciseId: id }, orderBy: { order: 'asc' } });
      expect(links.map((l) => [l.advancedTechniqueId, l.order])).toEqual([[b.id, 0], [a.id, 1]]);
    });

    it('should return an empty advancedTechniques array when the field is omitted (old clients)', async () => {
      const { trainer, trainingId } = await setup();

      const response = await post(trainer.accessToken, url(trainingId), exercise());

      expect(response.statusCode).toBe(201);
      expect(response.json().advancedTechniques).toEqual([]);
    });

    it('should return an empty advancedTechniques array when an empty list is sent', async () => {
      const { trainer, trainingId } = await setup();

      const response = await post(trainer.accessToken, url(trainingId), exercise({ advancedTechniqueIds: [] }));

      expect(response.statusCode).toBe(201);
      expect(response.json().advancedTechniques).toEqual([]);
    });

    it('should return 400 validation.failed for duplicate ids', async () => {
      const { trainer, trainingId, a } = await setup();

      const response = await post(trainer.accessToken, url(trainingId), exercise({ advancedTechniqueIds: [a.id, a.id] }));

      expectValidationFailed(response);
    });

    it(`should return 400 validation.failed for more than ${MAX_TECHNIQUES} ids`, async () => {
      const { trainer, trainingId } = await setup();
      const ids = Array.from({ length: MAX_TECHNIQUES + 1 }, () => crypto.randomUUID());

      const response = await post(trainer.accessToken, url(trainingId), exercise({ advancedTechniqueIds: ids }));

      expectValidationFailed(response);
    });

    it('should return 400 validation.failed for a non-uuid id', async () => {
      const { trainer, trainingId } = await setup();

      const response = await post(trainer.accessToken, url(trainingId), exercise({ advancedTechniqueIds: ['nope'] }));

      expectValidationFailed(response);
    });

    it(`should accept exactly ${MAX_TECHNIQUES} techniques`, async () => {
      const { trainer, trainingId } = await setup();
      const created = [];
      for (let i = 0; i < MAX_TECHNIQUES; i += 1) {
        created.push(await fx.createTechnique(trainer.accessToken, { name: `Tech ${i}` }));
      }

      const response = await post(
        trainer.accessToken,
        url(trainingId),
        exercise({ advancedTechniqueIds: created.map((t) => t.id) }),
      );

      expect(response.statusCode).toBe(201);
      expect(response.json().advancedTechniques).toHaveLength(MAX_TECHNIQUES);
    });

    it('should return 400 ADVANCED_TECHNIQUE_INVALID_SELECTION for a nonexistent id', async () => {
      const { trainer, trainingId } = await setup();

      const response = await post(
        trainer.accessToken,
        url(trainingId),
        exercise({ advancedTechniqueIds: [crypto.randomUUID()] }),
      );

      expectInvalidSelection(response);
    });

    it("should return 400 ADVANCED_TECHNIQUE_INVALID_SELECTION for another trainer's private technique", async () => {
      const { trainer, trainingId } = await setup();
      const other = await fx.createTrainer();
      const foreign = await fx.createTechnique(other.accessToken, { name: 'Foreign' });

      const response = await post(trainer.accessToken, url(trainingId), exercise({ advancedTechniqueIds: [foreign.id] }));

      expectInvalidSelection(response);
    });

    it('should return 400 ADVANCED_TECHNIQUE_INVALID_SELECTION for a soft-deleted technique', async () => {
      const { trainer, trainingId, a } = await setup();
      await fx.deleteTechnique(trainer.accessToken, a.id);

      const response = await post(trainer.accessToken, url(trainingId), exercise({ advancedTechniqueIds: [a.id] }));

      expectInvalidSelection(response);
    });

    it('should not create the exercise when the selection is invalid', async () => {
      const { trainer, trainingId } = await setup();

      await post(trainer.accessToken, url(trainingId), exercise({ advancedTechniqueIds: [crypto.randomUUID()] }));

      const list = await get(trainer.accessToken, url(trainingId));
      expect(list.json()).toHaveLength(0);
    });
  });


  describe('PATCH /trainer/exercises/:id', () => {
    it('should replace the whole set and order when the key is present', async () => {
      const { trainer, trainingId, a, b } = await setup();
      const created = await fx.createExercise(trainer.accessToken, trainingId, { advancedTechniqueIds: [a.id] });

      const response = await patch(trainer.accessToken, `/trainer/exercises/${created.id}`, {
        advancedTechniqueIds: [b.id, a.id],
      });

      expect(response.statusCode).toBe(200);
      expect(techniqueIds(response.json().advancedTechniques)).toEqual([b.id, a.id]);
      expect(response.json().advancedTechniques.map((t) => t.order)).toEqual([0, 1]);
    });

    it('should clear all techniques when an empty list is sent', async () => {
      const { trainer, trainingId, a, b } = await setup();
      const created = await fx.createExercise(trainer.accessToken, trainingId, { advancedTechniqueIds: [a.id, b.id] });

      const response = await patch(trainer.accessToken, `/trainer/exercises/${created.id}`, { advancedTechniqueIds: [] });

      expect(response.statusCode).toBe(200);
      expect(response.json().advancedTechniques).toEqual([]);
      expect(await prisma.exerciseAdvancedTechnique.count({ where: { exerciseId: created.id } })).toBe(0);
    });

    it('should keep the techniques when the key is absent (old clients)', async () => {
      const { trainer, trainingId, a, b } = await setup();
      const created = await fx.createExercise(trainer.accessToken, trainingId, { advancedTechniqueIds: [b.id, a.id] });

      const response = await patch(trainer.accessToken, `/trainer/exercises/${created.id}`, { name: 'Renamed' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ name: 'Renamed' });
      expect(techniqueIds(response.json().advancedTechniques)).toEqual([b.id, a.id]);
    });

    it('should return 400 ADVANCED_TECHNIQUE_INVALID_SELECTION and keep the previous set for an invalid id', async () => {
      const { trainer, trainingId, a } = await setup();
      const created = await fx.createExercise(trainer.accessToken, trainingId, { advancedTechniqueIds: [a.id] });

      const response = await patch(trainer.accessToken, `/trainer/exercises/${created.id}`, {
        advancedTechniqueIds: [crypto.randomUUID()],
      });

      expectInvalidSelection(response);
      const after = await get(trainer.accessToken, `/trainer/exercises/${created.id}`);
      expect(techniqueIds(after.json().advancedTechniques)).toEqual([a.id]);
    });

    it('should return 400 validation.failed for duplicate ids', async () => {
      const { trainer, trainingId, a } = await setup();
      const created = await fx.createExercise(trainer.accessToken, trainingId);

      const response = await patch(trainer.accessToken, `/trainer/exercises/${created.id}`, {
        advancedTechniqueIds: [a.id, a.id],
      });

      expectValidationFailed(response);
    });

    it('should return 400 validation.failed for more than 5 ids', async () => {
      const { trainer, trainingId } = await setup();
      const created = await fx.createExercise(trainer.accessToken, trainingId);

      const response = await patch(trainer.accessToken, `/trainer/exercises/${created.id}`, {
        advancedTechniqueIds: Array.from({ length: MAX_TECHNIQUES + 1 }, () => crypto.randomUUID()),
      });

      expectValidationFailed(response);
    });
  });


  describe('exercise responses carry advancedTechniques', () => {
    it('should return the ordered list on GET /trainer/trainings/:id/exercises and GET /trainer/exercises/:id', async () => {
      const { trainer, trainingId, a, b } = await setup();
      const created = await fx.createExercise(trainer.accessToken, trainingId, { advancedTechniqueIds: [b.id, a.id] });

      const list = await get(trainer.accessToken, `/trainer/trainings/${trainingId}/exercises`);
      const single = await get(trainer.accessToken, `/trainer/exercises/${created.id}`);

      expect(techniqueIds(list.json()[0].advancedTechniques)).toEqual([b.id, a.id]);
      expect(techniqueIds(single.json().advancedTechniques)).toEqual([b.id, a.id]);
    });

    it('should return [] on exercises without techniques', async () => {
      const { trainer, trainingId } = await setup();
      const created = await fx.createExercise(trainer.accessToken, trainingId);

      const single = await get(trainer.accessToken, `/trainer/exercises/${created.id}`);

      expect(single.json().advancedTechniques).toEqual([]);
    });

    it('should return the ordered list on GET /my/trainings/:trainingId/exercises', async () => {
      const { trainer, student, trainingId, a, b } = await setup();
      await fx.createExercise(trainer.accessToken, trainingId, { advancedTechniqueIds: [b.id, a.id] });

      const response = await get(student.accessToken, `/my/trainings/${trainingId}/exercises`);

      expect(response.statusCode).toBe(200);
      expect(techniqueIds(response.json()[0].advancedTechniques)).toEqual([b.id, a.id]);
      expect(Object.keys(response.json()[0].advancedTechniques[0]).sort()).toEqual([...REF_KEYS].sort());
    });

    it('should return the ordered list on GET /my/exercises/:id', async () => {
      const { trainer, student, trainingId, a, b } = await setup();
      const created = await fx.createExercise(trainer.accessToken, trainingId, { advancedTechniqueIds: [a.id, b.id] });

      const response = await get(student.accessToken, `/my/exercises/${created.id}`);

      expect(response.statusCode).toBe(200);
      expect(techniqueIds(response.json().advancedTechniques)).toEqual([a.id, b.id]);
    });

    it('should return the ordered list on GET /my/workouts/today', async () => {
      const { trainer, student, trainingId, a, b } = await setup();
      await fx.createExercise(trainer.accessToken, trainingId, { advancedTechniqueIds: [b.id, a.id] });

      const response = await get(student.accessToken, '/my/workouts/today', { 'app-timezone': 'UTC' });

      expect(response.statusCode).toBe(200);
      const { exercises } = response.json().workouts[0].targetTraining;
      expect(techniqueIds(exercises[0].advancedTechniques)).toEqual([b.id, a.id]);
    });

    it('should return [] on GET /my/workouts/today exercises without techniques', async () => {
      const { trainer, student, trainingId } = await setup();
      await fx.createExercise(trainer.accessToken, trainingId);

      const response = await get(student.accessToken, '/my/workouts/today', { 'app-timezone': 'UTC' });

      expect(response.json().workouts[0].targetTraining.exercises[0].advancedTechniques).toEqual([]);
    });

    it('should return the ordered list on workout session exerciseLogs[].exercise', async () => {
      const { trainer, student, trainingId, a, b } = await setup();
      await fx.createExercise(trainer.accessToken, trainingId, { advancedTechniqueIds: [b.id, a.id] });

      const started = await post(student.accessToken, `/my/trainings/${trainingId}/workout-sessions`, {});
      expect(started.statusCode).toBe(201);
      const fetched = await get(student.accessToken, `/my/workout-sessions/${started.json().id}`);

      expect(techniqueIds(started.json().exerciseLogs[0].exercise.advancedTechniques)).toEqual([b.id, a.id]);
      expect(techniqueIds(fetched.json().exerciseLogs[0].exercise.advancedTechniques)).toEqual([b.id, a.id]);
    });

    it('should keep returning a soft-deleted technique on exercises already linked (live reference)', async () => {
      const { trainer, student, trainingId, a, b } = await setup();
      const created = await fx.createExercise(trainer.accessToken, trainingId, { advancedTechniqueIds: [a.id, b.id] });
      await fx.deleteTechnique(trainer.accessToken, a.id);

      const response = await get(student.accessToken, `/my/exercises/${created.id}`);

      expect(response.statusCode).toBe(200);
      expect(techniqueIds(response.json().advancedTechniques)).toEqual([a.id, b.id]);
    });

    it('should reflect edits to a technique on already linked exercises (live reference)', async () => {
      const { trainer, student, trainingId, a } = await setup();
      const created = await fx.createExercise(trainer.accessToken, trainingId, { advancedTechniqueIds: [a.id] });
      await patch(trainer.accessToken, `/trainer/advanced-techniques/${a.id}`, { name: 'Edited name' });

      const response = await get(student.accessToken, `/my/exercises/${created.id}`);

      expect(response.json().advancedTechniques[0]).toMatchObject({ id: a.id, name: 'Edited name' });
    });

    it('should not allow deleting a technique to fail because exercises link to it', async () => {
      const { trainer, trainingId, a } = await setup();
      await fx.createExercise(trainer.accessToken, trainingId, { advancedTechniqueIds: [a.id] });

      const response = await app.inject({
        method: 'DELETE',
        url: `/trainer/advanced-techniques/${a.id}`,
        headers: bearer(trainer.accessToken),
      });

      expect(response.statusCode).toBe(200);
    });
  });


  describe('POST /trainer/protocols/with-trainings', () => {
    function payload(studentId, exercises) {
      return {
        assigneeId: studentId,
        name: 'Bulk',
        startDate: '2026-01-01',
        trainings: [{ name: 'Day A', category: 'strength', order: 0, exercises }],
      };
    }

    it('should store nested exercise techniques in the order sent', async () => {
      const trainer = await fx.createTrainer();
      const student = await fx.createStudent();
      await fx.linkStudent(trainer.trainerId, student.userId);
      const a = await fx.createTechnique(trainer.accessToken, { name: 'A' });
      const b = await fx.createTechnique(trainer.accessToken, { name: 'B' });

      const response = await post(
        trainer.accessToken,
        '/trainer/protocols/with-trainings',
        payload(student.userId, [
          { name: 'Squat', type: 'strength', order: 0, advancedTechniqueIds: [b.id, a.id] },
          { name: 'Curl', type: 'strength', order: 1 },
        ]),
      );

      expect(response.statusCode).toBe(201);
      const trainingId = response.json().trainings[0].id;
      const exercises = (await get(student.accessToken, `/my/trainings/${trainingId}/exercises`)).json();
      expect(techniqueIds(exercises[0].advancedTechniques)).toEqual([b.id, a.id]);
      expect(exercises[1].advancedTechniques).toEqual([]);
    });

    it('should return 400 ADVANCED_TECHNIQUE_INVALID_SELECTION and create nothing when a nested id is invalid', async () => {
      const trainer = await fx.createTrainer();
      const student = await fx.createStudent();
      await fx.linkStudent(trainer.trainerId, student.userId);
      const other = await fx.createTrainer();
      const foreign = await fx.createTechnique(other.accessToken, { name: 'Foreign' });

      const response = await post(
        trainer.accessToken,
        '/trainer/protocols/with-trainings',
        payload(student.userId, [{ name: 'Squat', type: 'strength', order: 0, advancedTechniqueIds: [foreign.id] }]),
      );

      expectInvalidSelection(response);
      expect(await prisma.trainingProtocol.count({ where: { trainerId: trainer.trainerId } })).toBe(0);
    });

    it('should return 400 validation.failed for duplicate nested ids', async () => {
      const trainer = await fx.createTrainer();
      const student = await fx.createStudent();
      await fx.linkStudent(trainer.trainerId, student.userId);
      const a = await fx.createTechnique(trainer.accessToken, { name: 'A' });

      const response = await post(
        trainer.accessToken,
        '/trainer/protocols/with-trainings',
        payload(student.userId, [{ name: 'Squat', type: 'strength', order: 0, advancedTechniqueIds: [a.id, a.id] }]),
      );

      expectValidationFailed(response);
    });
  });


  describe('exercise templates (POST/PATCH/GET /trainer/exercise-templates)', () => {
    it('should store techniques in order on create and return them', async () => {
      const { trainer, a, b } = await setup();

      const response = await post(trainer.accessToken, '/trainer/exercise-templates', {
        name: 'Leg Press',
        type: 'strength',
        advancedTechniqueIds: [b.id, a.id],
      });

      expect(response.statusCode).toBe(201);
      expect(techniqueIds(response.json().advancedTechniques)).toEqual([b.id, a.id]);
      expect(response.json().advancedTechniques.map((t) => t.order)).toEqual([0, 1]);
    });

    it('should return [] on create when the field is omitted', async () => {
      const { trainer } = await setup();

      const template = await fx.createExerciseTemplate(trainer.accessToken);

      expect(template.advancedTechniques).toEqual([]);
    });

    it('should return the techniques on GET list and GET by id', async () => {
      const { trainer, a, b } = await setup();
      const template = await fx.createExerciseTemplate(trainer.accessToken, { advancedTechniqueIds: [a.id, b.id] });

      const listResponse = await get(trainer.accessToken, '/trainer/exercise-templates');
      const byId = await get(trainer.accessToken, `/trainer/exercise-templates/${template.id}`);

      const listed = listResponse.json().data.find((t) => t.id === template.id);
      expect(techniqueIds(listed.advancedTechniques)).toEqual([a.id, b.id]);
      expect(techniqueIds(byId.json().advancedTechniques)).toEqual([a.id, b.id]);
    });

    it('should replace the set on PATCH when the key is present', async () => {
      const { trainer, a, b } = await setup();
      const template = await fx.createExerciseTemplate(trainer.accessToken, { advancedTechniqueIds: [a.id] });

      const response = await patch(trainer.accessToken, `/trainer/exercise-templates/${template.id}`, {
        advancedTechniqueIds: [b.id, a.id],
      });

      expect(response.statusCode).toBe(200);
      expect(techniqueIds(response.json().advancedTechniques)).toEqual([b.id, a.id]);
    });

    it('should clear the set on PATCH with an empty list', async () => {
      const { trainer, a } = await setup();
      const template = await fx.createExerciseTemplate(trainer.accessToken, { advancedTechniqueIds: [a.id] });

      const response = await patch(trainer.accessToken, `/trainer/exercise-templates/${template.id}`, {
        advancedTechniqueIds: [],
      });

      expect(response.json().advancedTechniques).toEqual([]);
    });

    it('should keep the set on PATCH when the key is absent', async () => {
      const { trainer, a, b } = await setup();
      const template = await fx.createExerciseTemplate(trainer.accessToken, { advancedTechniqueIds: [b.id, a.id] });

      const response = await patch(trainer.accessToken, `/trainer/exercise-templates/${template.id}`, { name: 'Renamed' });

      expect(response.statusCode).toBe(200);
      expect(techniqueIds(response.json().advancedTechniques)).toEqual([b.id, a.id]);
    });

    it('should return 400 ADVANCED_TECHNIQUE_INVALID_SELECTION for a deleted technique on create', async () => {
      const { trainer, a } = await setup();
      await fx.deleteTechnique(trainer.accessToken, a.id);

      const response = await post(trainer.accessToken, '/trainer/exercise-templates', {
        name: 'Leg Press',
        type: 'strength',
        advancedTechniqueIds: [a.id],
      });

      expectInvalidSelection(response);
    });

    it("should return 400 ADVANCED_TECHNIQUE_INVALID_SELECTION for another trainer's technique on PATCH", async () => {
      const { trainer } = await setup();
      const other = await fx.createTrainer();
      const foreign = await fx.createTechnique(other.accessToken, { name: 'Foreign' });
      const template = await fx.createExerciseTemplate(trainer.accessToken);

      const response = await patch(trainer.accessToken, `/trainer/exercise-templates/${template.id}`, {
        advancedTechniqueIds: [foreign.id],
      });

      expectInvalidSelection(response);
    });

    it('should return 400 validation.failed for duplicate ids', async () => {
      const { trainer, a } = await setup();

      const response = await post(trainer.accessToken, '/trainer/exercise-templates', {
        name: 'Leg Press',
        type: 'strength',
        advancedTechniqueIds: [a.id, a.id],
      });

      expectValidationFailed(response);
    });

    it('should return 400 validation.failed for more than 5 ids', async () => {
      const { trainer } = await setup();

      const response = await post(trainer.accessToken, '/trainer/exercise-templates', {
        name: 'Leg Press',
        type: 'strength',
        advancedTechniqueIds: Array.from({ length: MAX_TECHNIQUES + 1 }, () => crypto.randomUUID()),
      });

      expectValidationFailed(response);
    });
  });


  describe('POST /trainer/exercises/from-template inheritance', () => {
    const fromTemplate = (token, payload) => post(token, '/trainer/exercises/from-template', payload);

    it("should inherit the template's techniques in order when the field is omitted", async () => {
      const { trainer, trainingId, a, b } = await setup();
      const template = await fx.createExerciseTemplate(trainer.accessToken, { advancedTechniqueIds: [b.id, a.id] });

      const response = await fromTemplate(trainer.accessToken, { trainingId, templateId: template.id });

      expect(response.statusCode).toBe(201);
      expect(techniqueIds(response.json().advancedTechniques)).toEqual([b.id, a.id]);
    });

    it('should use the sent list instead of the template when the field is present', async () => {
      const { trainer, trainingId, a, b } = await setup();
      const template = await fx.createExerciseTemplate(trainer.accessToken, { advancedTechniqueIds: [a.id] });

      const response = await fromTemplate(trainer.accessToken, {
        trainingId,
        templateId: template.id,
        advancedTechniqueIds: [b.id],
      });

      expect(techniqueIds(response.json().advancedTechniques)).toEqual([b.id]);
    });

    it('should create the exercise with no techniques when an empty list is sent', async () => {
      const { trainer, trainingId, a } = await setup();
      const template = await fx.createExerciseTemplate(trainer.accessToken, { advancedTechniqueIds: [a.id] });

      const response = await fromTemplate(trainer.accessToken, {
        trainingId,
        templateId: template.id,
        advancedTechniqueIds: [],
      });

      expect(response.json().advancedTechniques).toEqual([]);
    });

    it('should return [] when the template has no techniques and the field is omitted', async () => {
      const { trainer, trainingId } = await setup();
      const template = await fx.createExerciseTemplate(trainer.accessToken);

      const response = await fromTemplate(trainer.accessToken, { trainingId, templateId: template.id });

      expect(response.json().advancedTechniques).toEqual([]);
    });

    it('should not link the exercise back to the template (copy, not reference)', async () => {
      const { trainer, trainingId, a, b } = await setup();
      const template = await fx.createExerciseTemplate(trainer.accessToken, { advancedTechniqueIds: [a.id] });
      const created = (await fromTemplate(trainer.accessToken, { trainingId, templateId: template.id })).json();

      await patch(trainer.accessToken, `/trainer/exercise-templates/${template.id}`, { advancedTechniqueIds: [b.id] });

      const exercise = await get(trainer.accessToken, `/trainer/exercises/${created.id}`);
      expect(techniqueIds(exercise.json().advancedTechniques)).toEqual([a.id]);
    });

    it('should return 400 ADVANCED_TECHNIQUE_INVALID_SELECTION for an invalid sent id', async () => {
      const { trainer, trainingId } = await setup();
      const template = await fx.createExerciseTemplate(trainer.accessToken);

      const response = await fromTemplate(trainer.accessToken, {
        trainingId,
        templateId: template.id,
        advancedTechniqueIds: [crypto.randomUUID()],
      });

      expectInvalidSelection(response);
    });
  });


  describe('training templates', () => {
    const junctionsOf = (template) => template.trainingTemplateExerciseTemplates;

    describe('POST /trainer/training-templates (exerciseTemplates[])', () => {
      it('should store junction techniques in the order sent and return them', async () => {
        const { trainer, a, b } = await setup();
        const et = await fx.createExerciseTemplate(trainer.accessToken);

        const template = await fx.createTrainingTemplate(trainer.accessToken, {
          exerciseTemplates: [{ exerciseTemplateId: et.id, advancedTechniqueIds: [b.id, a.id] }],
        });

        const [junction] = junctionsOf(template);
        expect(techniqueIds(junction.advancedTechniques)).toEqual([b.id, a.id]);
        expect(junction.advancedTechniques.map((t) => t.order)).toEqual([0, 1]);
      });

      it("should inherit the exercise template's techniques when the junction omits the field", async () => {
        const { trainer, a, b } = await setup();
        const et = await fx.createExerciseTemplate(trainer.accessToken, { advancedTechniqueIds: [a.id, b.id] });

        const template = await fx.createTrainingTemplate(trainer.accessToken, {
          exerciseTemplates: [{ exerciseTemplateId: et.id }],
        });

        expect(techniqueIds(junctionsOf(template)[0].advancedTechniques)).toEqual([a.id, b.id]);
      });

      it('should use the sent list instead of inheriting when the field is present', async () => {
        const { trainer, a, b } = await setup();
        const et = await fx.createExerciseTemplate(trainer.accessToken, { advancedTechniqueIds: [a.id] });

        const template = await fx.createTrainingTemplate(trainer.accessToken, {
          exerciseTemplates: [{ exerciseTemplateId: et.id, advancedTechniqueIds: [b.id] }],
        });

        expect(techniqueIds(junctionsOf(template)[0].advancedTechniques)).toEqual([b.id]);
      });

      it('should return [] for a junction with no techniques and none to inherit', async () => {
        const { trainer } = await setup();
        const et = await fx.createExerciseTemplate(trainer.accessToken);

        const template = await fx.createTrainingTemplate(trainer.accessToken, {
          exerciseTemplates: [{ exerciseTemplateId: et.id }],
        });

        expect(junctionsOf(template)[0].advancedTechniques).toEqual([]);
      });

      it('should return 400 ADVANCED_TECHNIQUE_INVALID_SELECTION for an invalid id', async () => {
        const { trainer } = await setup();
        const et = await fx.createExerciseTemplate(trainer.accessToken);

        const response = await post(trainer.accessToken, '/trainer/training-templates', {
          name: 'Leg Day',
          category: 'strength',
          exerciseTemplates: [{ exerciseTemplateId: et.id, advancedTechniqueIds: [crypto.randomUUID()] }],
        });

        expectInvalidSelection(response);
      });

      it('should return 400 validation.failed for duplicate ids', async () => {
        const { trainer, a } = await setup();
        const et = await fx.createExerciseTemplate(trainer.accessToken);

        const response = await post(trainer.accessToken, '/trainer/training-templates', {
          name: 'Leg Day',
          category: 'strength',
          exerciseTemplates: [{ exerciseTemplateId: et.id, advancedTechniqueIds: [a.id, a.id] }],
        });

        expectValidationFailed(response);
      });

      it('should return the junction techniques on GET /trainer/training-templates/:id', async () => {
        const { trainer, a, b } = await setup();
        const et = await fx.createExerciseTemplate(trainer.accessToken);
        const template = await fx.createTrainingTemplate(trainer.accessToken, {
          exerciseTemplates: [{ exerciseTemplateId: et.id, advancedTechniqueIds: [b.id, a.id] }],
        });

        const response = await get(trainer.accessToken, `/trainer/training-templates/${template.id}`);

        expect(techniqueIds(junctionsOf(response.json())[0].advancedTechniques)).toEqual([b.id, a.id]);
      });
    });

    describe('PATCH /trainer/training-templates/:id (exerciseTemplates[] full update)', () => {
      it('should recreate junctions with the techniques sent', async () => {
        const { trainer, a, b } = await setup();
        const et = await fx.createExerciseTemplate(trainer.accessToken);
        const template = await fx.createTrainingTemplate(trainer.accessToken, {
          exerciseTemplates: [{ exerciseTemplateId: et.id, advancedTechniqueIds: [a.id] }],
        });

        const response = await patch(trainer.accessToken, `/trainer/training-templates/${template.id}`, {
          exerciseTemplates: [{ exerciseTemplateId: et.id, advancedTechniqueIds: [b.id, a.id] }],
        });

        expect(response.statusCode).toBe(200);
        expect(techniqueIds(junctionsOf(response.json())[0].advancedTechniques)).toEqual([b.id, a.id]);
      });

      it('should return 400 ADVANCED_TECHNIQUE_INVALID_SELECTION for an invalid id and keep the previous junctions', async () => {
        const { trainer, a } = await setup();
        const et = await fx.createExerciseTemplate(trainer.accessToken);
        const template = await fx.createTrainingTemplate(trainer.accessToken, {
          exerciseTemplates: [{ exerciseTemplateId: et.id, advancedTechniqueIds: [a.id] }],
        });

        const response = await patch(trainer.accessToken, `/trainer/training-templates/${template.id}`, {
          exerciseTemplates: [{ exerciseTemplateId: et.id, advancedTechniqueIds: [crypto.randomUUID()] }],
        });

        expectInvalidSelection(response);
        const after = await get(trainer.accessToken, `/trainer/training-templates/${template.id}`);
        expect(techniqueIds(junctionsOf(after.json())[0].advancedTechniques)).toEqual([a.id]);
      });
    });

    describe('POST /trainer/training-templates/:templateId/exercises', () => {
      it('should store techniques in order on an ad-hoc junction', async () => {
        const { trainer, a, b } = await setup();
        const template = await fx.createTrainingTemplate(trainer.accessToken);

        const response = await post(trainer.accessToken, `/trainer/training-templates/${template.id}/exercises`, {
          name: 'Ad-hoc Squat',
          type: 'strength',
          advancedTechniqueIds: [b.id, a.id],
        });

        expect(response.statusCode).toBe(201);
        expect(techniqueIds(response.json().advancedTechniques)).toEqual([b.id, a.id]);
      });

      it('should return [] when the field is omitted', async () => {
        const { trainer } = await setup();
        const template = await fx.createTrainingTemplate(trainer.accessToken);

        const response = await post(trainer.accessToken, `/trainer/training-templates/${template.id}/exercises`, {
          name: 'Ad-hoc Squat',
          type: 'strength',
        });

        expect(response.json().advancedTechniques).toEqual([]);
      });

      it('should return 400 ADVANCED_TECHNIQUE_INVALID_SELECTION for another trainer technique', async () => {
        const { trainer } = await setup();
        const other = await fx.createTrainer();
        const foreign = await fx.createTechnique(other.accessToken, { name: 'Foreign' });
        const template = await fx.createTrainingTemplate(trainer.accessToken);

        const response = await post(trainer.accessToken, `/trainer/training-templates/${template.id}/exercises`, {
          name: 'Ad-hoc Squat',
          type: 'strength',
          advancedTechniqueIds: [foreign.id],
        });

        expectInvalidSelection(response);
      });
    });

    describe('POST /trainer/training-templates/:templateId/exercises/from-template', () => {
      const fromTemplateUrl = (templateId) => `/trainer/training-templates/${templateId}/exercises/from-template`;

      it("should inherit the exercise template's techniques in order when the field is omitted", async () => {
        const { trainer, a, b } = await setup();
        const et = await fx.createExerciseTemplate(trainer.accessToken, { advancedTechniqueIds: [b.id, a.id] });
        const template = await fx.createTrainingTemplate(trainer.accessToken);

        const response = await post(trainer.accessToken, fromTemplateUrl(template.id), { exerciseTemplateId: et.id });

        expect(response.statusCode).toBe(201);
        expect(techniqueIds(response.json().advancedTechniques)).toEqual([b.id, a.id]);
      });

      it('should use the sent list instead of inheriting when the field is present', async () => {
        const { trainer, a, b } = await setup();
        const et = await fx.createExerciseTemplate(trainer.accessToken, { advancedTechniqueIds: [a.id] });
        const template = await fx.createTrainingTemplate(trainer.accessToken);

        const response = await post(trainer.accessToken, fromTemplateUrl(template.id), {
          exerciseTemplateId: et.id,
          advancedTechniqueIds: [b.id],
        });

        expect(techniqueIds(response.json().advancedTechniques)).toEqual([b.id]);
      });
    });

    describe('PATCH /trainer/training-templates/:templateId/exercises/:exerciseId', () => {
      async function junctionFixture(withTechniques) {
        const ctx = await setup();
        const et = await fx.createExerciseTemplate(ctx.trainer.accessToken);
        const template = await fx.createTrainingTemplate(ctx.trainer.accessToken, {
          exerciseTemplates: [{ exerciseTemplateId: et.id, advancedTechniqueIds: withTechniques(ctx) }],
        });
        return { ...ctx, template, junction: junctionsOf(template)[0] };
      }
      const junctionUrl = ({ template, junction }) =>
        `/trainer/training-templates/${template.id}/exercises/${junction.id}`;

      it('should replace the junction techniques when the key is present', async () => {
        const ctx = await junctionFixture(({ a }) => [a.id]);

        const response = await patch(ctx.trainer.accessToken, junctionUrl(ctx), {
          advancedTechniqueIds: [ctx.b.id, ctx.a.id],
        });

        expect(response.statusCode).toBe(200);
        expect(techniqueIds(response.json().advancedTechniques)).toEqual([ctx.b.id, ctx.a.id]);
      });

      it('should clear the junction techniques with an empty list', async () => {
        const ctx = await junctionFixture(({ a }) => [a.id]);

        const response = await patch(ctx.trainer.accessToken, junctionUrl(ctx), { advancedTechniqueIds: [] });

        expect(response.json().advancedTechniques).toEqual([]);
      });

      it('should keep the junction techniques when the key is absent', async () => {
        const ctx = await junctionFixture(({ a, b }) => [b.id, a.id]);

        const response = await patch(ctx.trainer.accessToken, junctionUrl(ctx), { sets: 4 });

        expect(response.statusCode).toBe(200);
        expect(techniqueIds(response.json().advancedTechniques)).toEqual([ctx.b.id, ctx.a.id]);
      });

      it('should return 400 ADVANCED_TECHNIQUE_INVALID_SELECTION for an invalid id', async () => {
        const ctx = await junctionFixture(({ a }) => [a.id]);

        const response = await patch(ctx.trainer.accessToken, junctionUrl(ctx), {
          advancedTechniqueIds: [crypto.randomUUID()],
        });

        expectInvalidSelection(response);
      });
    });
  });


  describe('imports copy junction techniques to the new exercise in order', () => {
    async function templateWithTechniques() {
      const ctx = await setup();
      const et = await fx.createExerciseTemplate(ctx.trainer.accessToken);
      const trainingTemplate = await fx.createTrainingTemplate(ctx.trainer.accessToken, {
        exerciseTemplates: [
          { exerciseTemplateId: et.id, advancedTechniqueIds: [ctx.b.id, ctx.a.id] },
          { exerciseTemplateId: et.id },
        ],
      });
      return { ...ctx, trainingTemplate };
    }

    it('should copy techniques on POST /trainer/trainings/from-template and return them in the response', async () => {
      const { trainer, protocolId, trainingTemplate, a, b } = await templateWithTechniques();

      const response = await post(trainer.accessToken, '/trainer/trainings/from-template', {
        protocolId,
        templateId: trainingTemplate.id,
      });

      expect(response.statusCode).toBe(201);
      const exercises = response.json().exercises;
      expect(techniqueIds(exercises[0].advancedTechniques)).toEqual([b.id, a.id]);
      expect(exercises[1].advancedTechniques).toEqual([]);
    });

    it('should persist the copied techniques so the student reads them', async () => {
      const { trainer, student, protocolId, trainingTemplate, a, b } = await templateWithTechniques();
      const imported = await post(trainer.accessToken, '/trainer/trainings/from-template', {
        protocolId,
        templateId: trainingTemplate.id,
      });

      const exercises = await get(student.accessToken, `/my/trainings/${imported.json().id}/exercises`);

      expect(techniqueIds(exercises.json()[0].advancedTechniques)).toEqual([b.id, a.id]);
    });

    it('should snapshot the order: editing the template junction later does not change the imported exercise', async () => {
      const { trainer, protocolId, trainingTemplate, a, b } = await templateWithTechniques();
      const imported = await post(trainer.accessToken, '/trainer/trainings/from-template', {
        protocolId,
        templateId: trainingTemplate.id,
      });
      const junction = trainingTemplate.trainingTemplateExerciseTemplates[0];

      await patch(trainer.accessToken, `/trainer/training-templates/${trainingTemplate.id}/exercises/${junction.id}`, {
        advancedTechniqueIds: [a.id],
      });

      const exercises = await get(trainer.accessToken, `/trainer/trainings/${imported.json().id}/exercises`);
      expect(techniqueIds(exercises.json()[0].advancedTechniques)).toEqual([b.id, a.id]);
    });

    it('should copy techniques on POST /trainer/protocols/import-from-template', async () => {
      const { trainer, student, trainingTemplate, a, b } = await templateWithTechniques();
      const protocolTemplate = await post(trainer.accessToken, '/trainer/protocol-templates', {
        name: 'Full Body',
        trainings: [{ trainingTemplateId: trainingTemplate.id, weekDay: 'monday', order: 0 }],
      });
      expect(protocolTemplate.statusCode).toBe(201);

      const imported = await post(trainer.accessToken, '/trainer/protocols/import-from-template', {
        templateId: protocolTemplate.json().id,
        assigneeId: student.userId,
        startDate: '2026-03-01',
      });

      expect(imported.statusCode).toBe(201);
      const trainingId = imported.json().trainings[0].id;
      const exercises = await get(student.accessToken, `/my/trainings/${trainingId}/exercises`);
      expect(techniqueIds(exercises.json()[0].advancedTechniques)).toEqual([b.id, a.id]);
      expect(exercises.json()[1].advancedTechniques).toEqual([]);
    });
  });


  describe('old clients that omit advancedTechniqueIds', () => {
    it('should keep create, update and read behaviour unchanged with an empty advancedTechniques array', async () => {
      const { trainer, student, trainingId } = await setup();

      const created = await fx.createExercise(trainer.accessToken, trainingId, { notes: 'old client' });
      const updated = await patch(trainer.accessToken, `/trainer/exercises/${created.id}`, { sets: 5 });
      const read = await get(student.accessToken, `/my/exercises/${created.id}`);

      expect(created).toMatchObject({ name: 'Bench Press', sets: 3, notes: 'old client', advancedTechniques: [] });
      expect(updated.json()).toMatchObject({ sets: 5, advancedTechniques: [] });
      expect(read.json()).toMatchObject({ sets: 5, advancedTechniques: [] });
    });

    it('should leave exercises created from a template without techniques unchanged', async () => {
      const { trainer, trainingId } = await setup();
      const template = await fx.createExerciseTemplate(trainer.accessToken, { name: 'Plain' });

      const response = await post(trainer.accessToken, '/trainer/exercises/from-template', {
        trainingId,
        templateId: template.id,
        sets: 4,
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ name: 'Plain', sets: 4, advancedTechniques: [] });
    });
  });
});
