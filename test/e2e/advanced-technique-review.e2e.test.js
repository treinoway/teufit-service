import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { bearer, createAdvancedTechniqueFixtures, techniqueIds } from '../helpers/advanced-technique-e2e.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const SYSTEM_TECHNIQUE_KEY = 'drop_set';

e2eDescribe('e2e: advanced technique review fixes', () => {
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

  function post(token, url, payload) {
    return app.inject({ method: 'POST', url, headers: bearer(token), payload });
  }

  function get(token, url) {
    return app.inject({ method: 'GET', url, headers: bearer(token) });
  }

  async function createExerciseFromTemplate(trainer, student, exerciseTemplateId, extra = {}) {
    const response = await post(trainer.accessToken, '/trainer/protocols/with-trainings', {
      assigneeId: student.userId,
      name: 'Inherit',
      startDate: '2026-01-01',
      trainings: [{
        name: 'Day A',
        category: 'strength',
        order: 0,
        exercises: [{ name: 'Leg Press', type: 'strength', order: 0, exerciseTemplateId, ...extra }],
      }],
    });
    expect(response.statusCode).toBe(201);
    const trainingId = response.json().trainings[0].id;
    const exercises = (await get(student.accessToken, `/my/trainings/${trainingId}/exercises`)).json();
    return exercises[0];
  }

  describe('POST /trainer/protocols/with-trainings inheriting template techniques', () => {
    async function setup() {
      const trainer = await fx.createTrainer();
      const student = await fx.createStudent();
      await fx.linkStudent(trainer.trainerId, student.userId);
      const t1 = await fx.createTechnique(trainer.accessToken, { name: 'T1' });
      const t2 = await fx.createTechnique(trainer.accessToken, { name: 'T2' });
      return { trainer, student, t1, t2 };
    }

    it('should inherit the template techniques in order when advancedTechniqueIds is omitted', async () => {
      const { trainer, student, t1, t2 } = await setup();
      const template = await fx.createExerciseTemplate(trainer.accessToken, { advancedTechniqueIds: [t2.id, t1.id] });

      const exercise = await createExerciseFromTemplate(trainer, student, template.id);

      expect(techniqueIds(exercise.advancedTechniques)).toEqual([t2.id, t1.id]);
      expect(exercise.advancedTechniques.map((technique) => technique.order)).toEqual([0, 1]);
    });

    it('should drop a soft-deleted technique of the template and reindex the order', async () => {
      const { trainer, student, t1, t2 } = await setup();
      const t3 = await fx.createTechnique(trainer.accessToken, { name: 'T3' });
      const template = await fx.createExerciseTemplate(trainer.accessToken, { advancedTechniqueIds: [t1.id, t2.id, t3.id] });
      await fx.deleteTechnique(trainer.accessToken, t2.id);

      const exercise = await createExerciseFromTemplate(trainer, student, template.id);

      expect(techniqueIds(exercise.advancedTechniques)).toEqual([t1.id, t3.id]);
      expect(exercise.advancedTechniques.map((technique) => technique.order)).toEqual([0, 1]);
    });

    it('should drop another trainer private technique of a public template and reindex the order', async () => {
      const { trainer, student } = await setup();
      const owner = await fx.createTrainer();
      const foreign = await fx.createTechnique(owner.accessToken, { name: 'Foreign' });
      const system = await fx.systemTechniqueByKey(SYSTEM_TECHNIQUE_KEY);
      const template = await fx.createExerciseTemplate(owner.accessToken, {
        isPublic: true,
        advancedTechniqueIds: [foreign.id, system.id],
      });

      const exercise = await createExerciseFromTemplate(trainer, student, template.id);

      expect(techniqueIds(exercise.advancedTechniques)).toEqual([system.id]);
      expect(exercise.advancedTechniques[0].order).toBe(0);
    });

    it('should create no techniques when advancedTechniqueIds is an empty array', async () => {
      const { trainer, student, t1 } = await setup();
      const template = await fx.createExerciseTemplate(trainer.accessToken, { advancedTechniqueIds: [t1.id] });

      const exercise = await createExerciseFromTemplate(trainer, student, template.id, { advancedTechniqueIds: [] });

      expect(exercise.advancedTechniques).toEqual([]);
    });
  });

  describe('templates shared by another trainer hide private techniques', () => {
    async function setup() {
      const owner = await fx.createTrainer();
      const viewer = await fx.createTrainer();
      const privateTechnique = await fx.createTechnique(owner.accessToken, { name: 'Owner private' });
      const system = await fx.systemTechniqueByKey(SYSTEM_TECHNIQUE_KEY);
      const exerciseTemplate = await fx.createExerciseTemplate(owner.accessToken, {
        isPublic: true,
        advancedTechniqueIds: [privateTechnique.id, system.id],
      });
      const trainingTemplate = await fx.createTrainingTemplate(owner.accessToken, {
        isPublic: true,
        exerciseTemplates: [{ exerciseTemplateId: exerciseTemplate.id }],
      });
      return { owner, viewer, privateTechnique, system, exerciseTemplate, trainingTemplate };
    }

    const findById = (list, id) => list.find((item) => item.id === id);
    const junctionTechniques = (template) => template.trainingTemplateExerciseTemplates[0].advancedTechniques;

    function expectOnlySystem(techniques, system) {
      expect(techniqueIds(techniques)).toEqual([system.id]);
      expect(techniques[0].order).toBe(0);
    }

    function expectBoth(techniques, privateTechnique, system) {
      expect(techniqueIds(techniques)).toEqual([privateTechnique.id, system.id]);
      expect(techniques.map((technique) => technique.order)).toEqual([0, 1]);
    }

    it('should hide the private technique from another trainer on the exercise template list, by-id and public routes', async () => {
      const { viewer, system, exerciseTemplate } = await setup();

      const list = await get(viewer.accessToken, '/trainer/exercise-templates');
      const byId = await get(viewer.accessToken, `/trainer/exercise-templates/${exerciseTemplate.id}`);
      const pub = await get(viewer.accessToken, '/trainer/exercise-templates/public');

      expect(list.statusCode).toBe(200);
      expect(byId.statusCode).toBe(200);
      expect(pub.statusCode).toBe(200);
      expectOnlySystem(findById(list.json().data, exerciseTemplate.id).advancedTechniques, system);
      expectOnlySystem(byId.json().advancedTechniques, system);
      expectOnlySystem(findById(pub.json(), exerciseTemplate.id).advancedTechniques, system);
    });

    it('should hide the private technique from another trainer on the training template list, by-id and public routes', async () => {
      const { viewer, system, trainingTemplate } = await setup();

      const list = await get(viewer.accessToken, '/trainer/training-templates');
      const byId = await get(viewer.accessToken, `/trainer/training-templates/${trainingTemplate.id}`);
      const pub = await get(viewer.accessToken, '/trainer/training-templates/public');

      expect(list.statusCode).toBe(200);
      expect(byId.statusCode).toBe(200);
      expect(pub.statusCode).toBe(200);
      expectOnlySystem(junctionTechniques(findById(list.json().data, trainingTemplate.id)), system);
      expectOnlySystem(junctionTechniques(byId.json()), system);
      expectOnlySystem(junctionTechniques(findById(pub.json(), trainingTemplate.id)), system);
    });

    it('should still show both techniques to the owner on every exercise template route', async () => {
      const { owner, privateTechnique, system, exerciseTemplate } = await setup();

      const list = await get(owner.accessToken, '/trainer/exercise-templates');
      const byId = await get(owner.accessToken, `/trainer/exercise-templates/${exerciseTemplate.id}`);
      const pub = await get(owner.accessToken, '/trainer/exercise-templates/public');

      expectBoth(findById(list.json().data, exerciseTemplate.id).advancedTechniques, privateTechnique, system);
      expectBoth(byId.json().advancedTechniques, privateTechnique, system);
      expectBoth(findById(pub.json(), exerciseTemplate.id).advancedTechniques, privateTechnique, system);
    });

    it('should still show both techniques to the owner on every training template route', async () => {
      const { owner, privateTechnique, system, trainingTemplate } = await setup();

      const list = await get(owner.accessToken, '/trainer/training-templates');
      const byId = await get(owner.accessToken, `/trainer/training-templates/${trainingTemplate.id}`);
      const pub = await get(owner.accessToken, '/trainer/training-templates/public');

      expectBoth(junctionTechniques(findById(list.json().data, trainingTemplate.id)), privateTechnique, system);
      expectBoth(junctionTechniques(byId.json()), privateTechnique, system);
      expectBoth(junctionTechniques(findById(pub.json(), trainingTemplate.id)), privateTechnique, system);
    });
  });
});
