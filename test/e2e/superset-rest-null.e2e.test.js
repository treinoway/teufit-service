import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { createBisetHarness } from '../helpers/biset-e2e.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const FIRST_MEMBER_REST = 60;
const LAST_MEMBER_REST = 45;

e2eDescribe('e2e: POST supersets restInterval null handling', () => {
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

  async function postWithRest(restIntervalField) {
    const { trainer, trainingId } = await h.setupTraining();
    const a = await h.createExercise(trainer.accessToken, trainingId, { restInterval: FIRST_MEMBER_REST });
    const b = await h.createExercise(trainer.accessToken, trainingId, { restInterval: LAST_MEMBER_REST });
    const payload = { exerciseIds: [a.id, b.id], ...restIntervalField };
    const response = await h.postSuperset(trainer.accessToken, trainingId, payload);
    return { response, ids: [a.id, b.id] };
  }

  it('treats explicit null as omitted and defaults to the last member restInterval', async () => {
    const { response, ids } = await postWithRest({ restInterval: null });

    expect(response.statusCode).toBe(201);
    expect(response.json().restInterval).toBe(LAST_MEMBER_REST);
    expect(await h.dbRestIntervals(ids)).toEqual({ [ids[0]]: LAST_MEMBER_REST, [ids[1]]: LAST_MEMBER_REST });
  });

  it('keeps an explicit 0 as 0', async () => {
    const { response, ids } = await postWithRest({ restInterval: 0 });

    expect(response.statusCode).toBe(201);
    expect(response.json().restInterval).toBe(0);
    expect(await h.dbRestIntervals(ids)).toEqual({ [ids[0]]: 0, [ids[1]]: 0 });
  });

  it('keeps omitted defaulting to the last member restInterval', async () => {
    const { response } = await postWithRest({});

    expect(response.statusCode).toBe(201);
    expect(response.json().restInterval).toBe(LAST_MEMBER_REST);
  });
});
