import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { createBisetHarness } from '../helpers/biset-e2e.js';
import { provisionTrainerPlan } from '../helpers/platform-plan.js';
import { SupersetMessageCode } from '../../src/constants/training.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

e2eDescribe('e2e: training template superset edge cases', () => {
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

  // why: X, Y, Z share order 0, as when a template reorder was never persisted.
  async function createTiedTemplate(token) {
    const headers = { authorization: `Bearer ${token}` };
    const exerciseTemplates = [];
    for (const name of ['X', 'Y', 'Z']) {
      const library = await app.inject({ method: 'POST', url: '/trainer/exercise-templates', headers, payload: { name, type: 'strength' } });
      exerciseTemplates.push({ exerciseTemplateId: library.json().id, order: 0, sets: 3 });
    }
    const response = await app.inject({
      method: 'POST',
      url: '/trainer/training-templates',
      headers,
      payload: { name: 'Tied', category: 'strength', exerciseTemplates },
    });
    expect(response.statusCode).toBe(201);
    return response.json();
  }

  function postSuperset(token, templateId, payload) {
    return app.inject({
      method: 'POST',
      url: `/trainer/training-templates/${templateId}/supersets`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  }

  it('rejects duplicate ids with supersetMembershipInvalid', async () => {
    const trainer = await h.createTrainer();
    await provisionTrainerPlan(trainer.trainerId);
    const template = await createTiedTemplate(trainer.accessToken);
    const [first] = template.trainingTemplateExerciseTemplates;

    const response = await postSuperset(trainer.accessToken, template.id, { exerciseIds: [first.id, first.id] });

    expect(response.statusCode).toBe(400);
    expect(response.json().messageCode).toBe(SupersetMessageCode.MEMBERSHIP_INVALID);
  });

  it('keeps a tied exercise displayed before the first member in front of the block', async () => {
    const trainer = await h.createTrainer();
    await provisionTrainerPlan(trainer.trainerId);
    const template = await createTiedTemplate(trainer.accessToken);
    const displayed = template.trainingTemplateExerciseTemplates;
    const [head, ...tail] = displayed;

    const response = await postSuperset(trainer.accessToken, template.id, { exerciseIds: tail.map((j) => j.id) });

    expect(response.statusCode).toBe(201);
    expect(response.json().trainingTemplateExerciseTemplates.map((j) => [j.id, j.order])).toEqual([
      [head.id, 0],
      [tail[0].id, 1],
      [tail[1].id, 2],
    ]);
  });
});
