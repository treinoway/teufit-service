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

e2eDescribe('e2e: substitute video key inherited from a visible template', () => {
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

  async function setup() {
    const ctx = await h.setupTraining();
    const other = await h.createTrainer();
    const key = foreignKey(other.trainerId);
    const template = await prisma.exerciseTemplate.create({
      data: { trainerId: other.trainerId, name: 'Shared', type: 'strength', videoFileKey: key, isPublic: true },
    });
    const principalResponse = await app.inject({
      method: 'POST',
      url: `/trainer/trainings/${ctx.trainingId}/exercises`,
      headers: auth(ctx.trainer.accessToken),
      payload: { name: 'Principal', type: 'strength', sets: 3 },
    });
    expect(principalResponse.statusCode).toBe(201);
    return { ...ctx, other, key, template, principalId: principalResponse.json().id };
  }

  function postSubstitute(token, principalId, payload) {
    return app.inject({
      method: 'POST',
      url: `/trainer/exercises/${principalId}/substitutes`,
      headers: auth(token),
      payload: { name: 'Sub', type: 'strength', sets: 3, ...payload },
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

  it('should accept the key of a public foreign template when the substitute references that template', async () => {
    const { trainer, principalId, key, template } = await setup();

    const response = await postSubstitute(trainer.accessToken, principalId, {
      exerciseTemplateId: template.id,
      videoFileKey: key,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toHaveProperty('videoFileKey', key);
  });

  it('should reject the foreign key when the substitute has no exerciseTemplateId', async () => {
    const { trainer, principalId, key } = await setup();

    const response = await postSubstitute(trainer.accessToken, principalId, { videoFileKey: key });

    expectInvalidKeyContract(response);
  });

  it('should reject a foreign key that differs from the referenced template key', async () => {
    const { trainer, principalId, other, template } = await setup();

    const response = await postSubstitute(trainer.accessToken, principalId, {
      exerciseTemplateId: template.id,
      videoFileKey: foreignKey(other.trainerId),
    });

    expectInvalidKeyContract(response);
  });
});
