import 'dotenv/config';
import crypto from 'node:crypto';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { prisma } from '../../src/db.js';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { createBisetHarness, todayWeekday } from '../helpers/biset-e2e.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const DISABLED_S3_URL = 'https://example.com/disabled-s3-upload';
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const UPLOAD_URL_PATH = '/trainer/exercise-videos/upload-url';
const KEY_PREFIX = 'exercise-videos/';
const UPLOAD_METHOD = 'PUT';
const YOUTUBE_URL = 'https://www.youtube.com/watch?v=IODxDxX7oi4';
const INVALID_KEY_MESSAGE_CODE = 'exerciseVideo.invalidFileKey';
const VALIDATION_MESSAGE_CODE = 'validation.failed';

const CONTENT_TYPE_EXTENSIONS = [
  ['video/mp4', 'mp4'],
  ['video/quicktime', 'mov'],
  ['video/webm', 'webm'],
];

e2eDescribe('e2e: exercise video upload (videoFileKey)', () => {
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

  function ownKey(trainerId, extension = 'mp4') {
    return `${KEY_PREFIX}${trainerId}/${crypto.randomUUID()}.${extension}`;
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

  function expectValidationContract(response) {
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'VALIDATION_ERROR', messageCode: VALIDATION_MESSAGE_CODE });
  }

  function expectFile(body, key) {
    expect(body).toHaveProperty('videoFileKey', key);
    expect(body).toHaveProperty('videoFileUrl', key ? DISABLED_S3_URL : null);
  }

  function postUploadUrl(token, payload) {
    return app.inject({ method: 'POST', url: UPLOAD_URL_PATH, headers: token ? auth(token) : {}, payload });
  }

  function createTemplate(token, payload = {}) {
    return app.inject({
      method: 'POST',
      url: '/trainer/exercise-templates',
      headers: auth(token),
      payload: { name: 'Squat', type: 'strength', ...payload },
    });
  }

  function patchTemplate(token, id, payload) {
    return app.inject({ method: 'PATCH', url: `/trainer/exercise-templates/${id}`, headers: auth(token), payload });
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

  describe('POST /trainer/exercise-videos/upload-url (criterion 1)', () => {
    it.each(CONTENT_TYPE_EXTENSIONS)(
      'returns a presigned PUT descriptor scoped to the trainer for %s',
      async (contentType, extension) => {
        const trainer = await h.createTrainer();

        const response = await postUploadUrl(trainer.accessToken, { contentType, sizeBytes: 5 * 1024 * 1024 });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.key).toMatch(
          new RegExp(`^exercise-videos/${trainer.trainerId}/[0-9a-f-]{36}\\.${extension}$`),
        );
        expect(body).toMatchObject({
          uploadUrl: DISABLED_S3_URL,
          method: UPLOAD_METHOD,
          headers: { 'Content-Type': contentType },
        });
        expect(new Date(body.expiresAt).toISOString()).toBe(body.expiresAt);
      },
    );

    it('sets expiresAt in the future', async () => {
      const trainer = await h.createTrainer();

      const response = await postUploadUrl(trainer.accessToken, { contentType: 'video/mp4', sizeBytes: 1024 });

      expect(response.statusCode).toBe(200);
      expect(new Date(response.json().expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it('accepts a file of exactly 100MB', async () => {
      const trainer = await h.createTrainer();

      const response = await postUploadUrl(trainer.accessToken, {
        contentType: 'video/mp4',
        sizeBytes: MAX_VIDEO_BYTES,
      });

      expect(response.statusCode).toBe(200);
    });

    it('returns a different key on every call', async () => {
      const trainer = await h.createTrainer();
      const payload = { contentType: 'video/mp4', sizeBytes: 1024 };

      const first = await postUploadUrl(trainer.accessToken, payload);
      const second = await postUploadUrl(trainer.accessToken, payload);

      expect(first.json().key).not.toBe(second.json().key);
    });

    it('returns 401 without a token', async () => {
      const response = await postUploadUrl(null, { contentType: 'video/mp4', sizeBytes: 1024 });

      expect(response.statusCode).toBe(401);
    });

    it('returns 403 for a student', async () => {
      const student = await h.createStudent();

      const response = await postUploadUrl(student.accessToken, { contentType: 'video/mp4', sizeBytes: 1024 });

      expect(response.statusCode).toBe(403);
    });

    it.each([
      ['unsupported content type', { contentType: 'video/x-msvideo', sizeBytes: 1024 }],
      ['non-video content type', { contentType: 'image/png', sizeBytes: 1024 }],
      ['size above 100MB', { contentType: 'video/mp4', sizeBytes: MAX_VIDEO_BYTES + 1 }],
      ['size zero', { contentType: 'video/mp4', sizeBytes: 0 }],
      ['negative size', { contentType: 'video/mp4', sizeBytes: -5 }],
      ['non-integer size', { contentType: 'video/mp4', sizeBytes: 10.5 }],
      ['missing sizeBytes', { contentType: 'video/mp4' }],
      ['missing contentType', { sizeBytes: 1024 }],
    ])('returns the validation error contract for %s', async (_label, payload) => {
      const trainer = await h.createTrainer();

      const response = await postUploadUrl(trainer.accessToken, payload);

      expectValidationContract(response);
    });
  });

  describe('exercise templates (criteria 2, 3, 5)', () => {
    it('stores videoFileKey on create and returns the signed videoFileUrl', async () => {
      const trainer = await h.createTrainer();
      const key = ownKey(trainer.trainerId);

      const response = await createTemplate(trainer.accessToken, { videoFileKey: key });

      expect(response.statusCode).toBe(201);
      expectFile(response.json(), key);
    });

    it('keeps videoUrl and videoFileKey side by side', async () => {
      const trainer = await h.createTrainer();
      const key = ownKey(trainer.trainerId);

      const response = await createTemplate(trainer.accessToken, { videoUrl: YOUTUBE_URL, videoFileKey: key });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toHaveProperty('videoUrl', YOUTUBE_URL);
      expectFile(response.json(), key);
    });

    it('returns null videoFileKey and videoFileUrl when an old client omits the field', async () => {
      const trainer = await h.createTrainer();

      const response = await createTemplate(trainer.accessToken, { videoUrl: YOUTUBE_URL });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toHaveProperty('videoUrl', YOUTUBE_URL);
      expectFile(response.json(), null);
    });

    it('accepts an explicit null on create', async () => {
      const trainer = await h.createTrainer();

      const response = await createTemplate(trainer.accessToken, { videoFileKey: null });

      expect(response.statusCode).toBe(201);
      expectFile(response.json(), null);
    });

    it('returns the file fields on GET by id', async () => {
      const trainer = await h.createTrainer();
      const key = ownKey(trainer.trainerId);
      const created = (await createTemplate(trainer.accessToken, { videoFileKey: key })).json();

      const response = await app.inject({
        method: 'GET',
        url: `/trainer/exercise-templates/${created.id}`,
        headers: auth(trainer.accessToken),
      });

      expect(response.statusCode).toBe(200);
      expectFile(response.json(), key);
    });

    it('returns the file fields on the list endpoint', async () => {
      const trainer = await h.createTrainer();
      const key = ownKey(trainer.trainerId);
      await createTemplate(trainer.accessToken, { videoFileKey: key });

      const response = await app.inject({
        method: 'GET',
        url: '/trainer/exercise-templates',
        headers: auth(trainer.accessToken),
      });

      expect(response.statusCode).toBe(200);
      const items = response.json().items ?? response.json().data ?? response.json();
      expectFile(items[0], key);
    });

    it('sets videoFileKey on update', async () => {
      const trainer = await h.createTrainer();
      const created = (await createTemplate(trainer.accessToken)).json();
      const key = ownKey(trainer.trainerId, 'webm');

      const response = await patchTemplate(trainer.accessToken, created.id, { videoFileKey: key });

      expect(response.statusCode).toBe(200);
      expectFile(response.json(), key);
    });

    it('clears videoFileKey when null is sent', async () => {
      const trainer = await h.createTrainer();
      const created = (await createTemplate(trainer.accessToken, { videoFileKey: ownKey(trainer.trainerId) })).json();

      const response = await patchTemplate(trainer.accessToken, created.id, { videoFileKey: null });

      expect(response.statusCode).toBe(200);
      expectFile(response.json(), null);
    });

    it('keeps videoFileKey when an update omits the field', async () => {
      const trainer = await h.createTrainer();
      const key = ownKey(trainer.trainerId);
      const created = (await createTemplate(trainer.accessToken, { videoFileKey: key })).json();

      const response = await patchTemplate(trainer.accessToken, created.id, { name: 'Renamed' });

      expect(response.statusCode).toBe(200);
      expectFile(response.json(), key);
    });

    it('rejects a key under another trainer prefix on create', async () => {
      const trainer = await h.createTrainer();
      const other = await h.createTrainer();

      const response = await createTemplate(trainer.accessToken, { videoFileKey: ownKey(other.trainerId) });

      expectInvalidKeyContract(response);
    });

    it('rejects a key outside the exercise-videos prefix on create', async () => {
      const trainer = await h.createTrainer();

      const response = await createTemplate(trainer.accessToken, {
        videoFileKey: `tutorials/${crypto.randomUUID()}.mp4`,
      });

      expectInvalidKeyContract(response);
    });

    it('rejects a key under another trainer prefix on update and leaves the template unchanged', async () => {
      const trainer = await h.createTrainer();
      const other = await h.createTrainer();
      const key = ownKey(trainer.trainerId);
      const created = (await createTemplate(trainer.accessToken, { videoFileKey: key })).json();

      const response = await patchTemplate(trainer.accessToken, created.id, {
        videoFileKey: ownKey(other.trainerId),
      });

      expectInvalidKeyContract(response);
      const stored = await prisma.exerciseTemplate.findUnique({ where: { id: created.id } });
      expect(stored.videoFileKey).toBe(key);
    });

    it('returns the validation error contract when videoFileKey is not a string', async () => {
      const trainer = await h.createTrainer();

      const response = await createTemplate(trainer.accessToken, { videoFileKey: 123 });

      expectValidationContract(response);
    });
  });

  describe('exercises (criteria 2, 3, 5)', () => {
    it('stores videoFileKey on create and returns the signed videoFileUrl', async () => {
      const { trainer, trainingId } = await h.setupTraining();
      const key = ownKey(trainer.trainerId);

      const response = await postExercise(trainer.accessToken, trainingId, { videoFileKey: key });

      expect(response.statusCode).toBe(201);
      expectFile(response.json(), key);
    });

    it('returns null file fields when an old client omits the field', async () => {
      const { trainer, trainingId } = await h.setupTraining();

      const response = await postExercise(trainer.accessToken, trainingId, { videoUrl: YOUTUBE_URL });

      expect(response.statusCode).toBe(201);
      expectFile(response.json(), null);
    });

    it('rejects a foreign key on create', async () => {
      const { trainer, trainingId } = await h.setupTraining();
      const other = await h.createTrainer();

      const response = await postExercise(trainer.accessToken, trainingId, {
        videoFileKey: ownKey(other.trainerId),
      });

      expectInvalidKeyContract(response);
    });

    it('returns the file fields on GET by id', async () => {
      const { trainer, trainingId } = await h.setupTraining();
      const key = ownKey(trainer.trainerId);
      const created = (await postExercise(trainer.accessToken, trainingId, { videoFileKey: key })).json();

      const response = await app.inject({
        method: 'GET',
        url: `/trainer/exercises/${created.id}`,
        headers: auth(trainer.accessToken),
      });

      expect(response.statusCode).toBe(200);
      expectFile(response.json(), key);
    });

    it('returns the file fields on the training exercise list', async () => {
      const { trainer, trainingId } = await h.setupTraining();
      const key = ownKey(trainer.trainerId);
      await postExercise(trainer.accessToken, trainingId, { videoFileKey: key });

      const response = await app.inject({
        method: 'GET',
        url: `/trainer/trainings/${trainingId}/exercises`,
        headers: auth(trainer.accessToken),
      });

      expect(response.statusCode).toBe(200);
      const items = response.json().items ?? response.json().data ?? response.json();
      expectFile(items[0], key);
    });

    it('sets, keeps and clears videoFileKey across updates', async () => {
      const { trainer, trainingId } = await h.setupTraining();
      const created = (await postExercise(trainer.accessToken, trainingId, {})).json();
      const key = ownKey(trainer.trainerId, 'mov');

      const set = await patchExercise(trainer.accessToken, created.id, { videoFileKey: key });
      const kept = await patchExercise(trainer.accessToken, created.id, { notes: 'untouched key' });
      const cleared = await patchExercise(trainer.accessToken, created.id, { videoFileKey: null });

      expectFile(set.json(), key);
      expectFile(kept.json(), key);
      expectFile(cleared.json(), null);
    });

    it('rejects a foreign key on update', async () => {
      const { trainer, trainingId } = await h.setupTraining();
      const other = await h.createTrainer();
      const created = (await postExercise(trainer.accessToken, trainingId, {})).json();

      const response = await patchExercise(trainer.accessToken, created.id, {
        videoFileKey: ownKey(other.trainerId),
      });

      expectInvalidKeyContract(response);
    });
  });

  describe('POST /trainer/exercises/from-template (criterion 4)', () => {
    function fromTemplate(token, trainingId, templateId, payload = {}) {
      return app.inject({
        method: 'POST',
        url: '/trainer/exercises/from-template',
        headers: auth(token),
        payload: { trainingId, templateId, sets: 3, ...payload },
      });
    }

    it('inherits the template videoFileKey when the body omits it', async () => {
      const { trainer, trainingId } = await h.setupTraining();
      const key = ownKey(trainer.trainerId);
      const template = (await createTemplate(trainer.accessToken, { videoFileKey: key })).json();

      const response = await fromTemplate(trainer.accessToken, trainingId, template.id);

      expect(response.statusCode).toBe(201);
      expectFile(response.json(), key);
    });

    it('uses the body videoFileKey over the template value', async () => {
      const { trainer, trainingId } = await h.setupTraining();
      const template = (await createTemplate(trainer.accessToken, { videoFileKey: ownKey(trainer.trainerId) })).json();
      const override = ownKey(trainer.trainerId, 'webm');

      const response = await fromTemplate(trainer.accessToken, trainingId, template.id, { videoFileKey: override });

      expect(response.statusCode).toBe(201);
      expectFile(response.json(), override);
    });

    it('clears the inherited value when the body sends null', async () => {
      const { trainer, trainingId } = await h.setupTraining();
      const template = (await createTemplate(trainer.accessToken, { videoFileKey: ownKey(trainer.trainerId) })).json();

      const response = await fromTemplate(trainer.accessToken, trainingId, template.id, { videoFileKey: null });

      expect(response.statusCode).toBe(201);
      expectFile(response.json(), null);
    });

    it('rejects a foreign key', async () => {
      const { trainer, trainingId } = await h.setupTraining();
      const other = await h.createTrainer();
      const template = (await createTemplate(trainer.accessToken)).json();

      const response = await fromTemplate(trainer.accessToken, trainingId, template.id, {
        videoFileKey: ownKey(other.trainerId),
      });

      expectInvalidKeyContract(response);
    });
  });

  describe('POST /trainer/exercises/:id/substitutes (criteria 2, 4)', () => {
    function addSubstitute(token, principalId, payload) {
      return app.inject({
        method: 'POST',
        url: `/trainer/exercises/${principalId}/substitutes`,
        headers: auth(token),
        payload: { name: 'Leg Press', type: 'strength', sets: 3, ...payload },
      });
    }

    it('stores videoFileKey on the substitute', async () => {
      const { trainer, trainingId } = await h.setupTraining();
      const principal = await h.createExercise(trainer.accessToken, trainingId);
      const key = ownKey(trainer.trainerId);

      const response = await addSubstitute(trainer.accessToken, principal.id, { videoFileKey: key });

      expect(response.statusCode).toBe(201);
      expectFile(response.json(), key);
    });

    it('inherits videoFileKey from the linked template when the body omits it', async () => {
      const { trainer, trainingId } = await h.setupTraining();
      const principal = await h.createExercise(trainer.accessToken, trainingId);
      const key = ownKey(trainer.trainerId);
      const template = (await createTemplate(trainer.accessToken, { videoFileKey: key })).json();

      const response = await addSubstitute(trainer.accessToken, principal.id, { exerciseTemplateId: template.id });

      expect(response.statusCode).toBe(201);
      expectFile(response.json(), key);
    });

    it('rejects a foreign key', async () => {
      const { trainer, trainingId } = await h.setupTraining();
      const other = await h.createTrainer();
      const principal = await h.createExercise(trainer.accessToken, trainingId);

      const response = await addSubstitute(trainer.accessToken, principal.id, {
        videoFileKey: ownKey(other.trainerId),
      });

      expectInvalidKeyContract(response);
    });

    it('returns the substitute file fields nested in the principal exercise', async () => {
      const { trainer, trainingId } = await h.setupTraining();
      const principal = await h.createExercise(trainer.accessToken, trainingId);
      const key = ownKey(trainer.trainerId);
      await addSubstitute(trainer.accessToken, principal.id, { videoFileKey: key });

      const response = await app.inject({
        method: 'GET',
        url: `/trainer/exercises/${principal.id}`,
        headers: auth(trainer.accessToken),
      });

      expect(response.statusCode).toBe(200);
      expectFile(response.json().substitutes[0], key);
    });
  });

  describe('training templates (criteria 2, 3, 4)', () => {
    async function createTrainingTemplate(token, payload) {
      return app.inject({
        method: 'POST',
        url: '/trainer/training-templates',
        headers: auth(token),
        payload: { name: 'Leg Day', category: 'strength', ...payload },
      });
    }

    it('persists videoFileKey on nested exerciseTemplates junction rows', async () => {
      const trainer = await h.createTrainer();
      const template = (await createTemplate(trainer.accessToken)).json();
      const key = ownKey(trainer.trainerId);

      const response = await createTrainingTemplate(trainer.accessToken, {
        exerciseTemplates: [
          { exerciseTemplateId: template.id, videoFileKey: key },
          { exerciseTemplateId: template.id },
        ],
      });

      expect(response.statusCode).toBe(201);
      const junctions = response.json().trainingTemplateExerciseTemplates;
      expect(junctions.map((j) => j.videoFileKey).sort()).toEqual([key, null].sort());
      const withKey = junctions.find((j) => j.videoFileKey === key);
      expectFile(withKey, key);
    });

    it('rejects a foreign key in nested exerciseTemplates', async () => {
      const trainer = await h.createTrainer();
      const other = await h.createTrainer();
      const template = (await createTemplate(trainer.accessToken)).json();

      const response = await createTrainingTemplate(trainer.accessToken, {
        exerciseTemplates: [{ exerciseTemplateId: template.id, videoFileKey: ownKey(other.trainerId) }],
      });

      expectInvalidKeyContract(response);
    });

    it('replaces junction rows with videoFileKey on PATCH of the training template', async () => {
      const trainer = await h.createTrainer();
      const template = (await createTemplate(trainer.accessToken)).json();
      const created = (await createTrainingTemplate(trainer.accessToken, {})).json();
      const key = ownKey(trainer.trainerId);

      const response = await app.inject({
        method: 'PATCH',
        url: `/trainer/training-templates/${created.id}`,
        headers: auth(trainer.accessToken),
        payload: { exerciseTemplates: [{ exerciseTemplateId: template.id, videoFileKey: key }] },
      });

      expect(response.statusCode).toBe(200);
      expectFile(response.json().trainingTemplateExerciseTemplates[0], key);
    });

    it('stores videoFileKey on an ad-hoc junction exercise', async () => {
      const trainer = await h.createTrainer();
      const created = (await createTrainingTemplate(trainer.accessToken, {})).json();
      const key = ownKey(trainer.trainerId);

      const response = await app.inject({
        method: 'POST',
        url: `/trainer/training-templates/${created.id}/exercises`,
        headers: auth(trainer.accessToken),
        payload: { name: 'Lunge', type: 'strength', videoFileKey: key },
      });

      expect(response.statusCode).toBe(201);
      expectFile(response.json(), key);
    });

    it('copies the template videoFileKey to the junction row on from-template link', async () => {
      const trainer = await h.createTrainer();
      const key = ownKey(trainer.trainerId);
      const template = (await createTemplate(trainer.accessToken, { videoFileKey: key })).json();
      const created = (await createTrainingTemplate(trainer.accessToken, {})).json();

      const response = await app.inject({
        method: 'POST',
        url: `/trainer/training-templates/${created.id}/exercises/from-template`,
        headers: auth(trainer.accessToken),
        payload: { exerciseTemplateId: template.id },
      });

      expect(response.statusCode).toBe(201);
      expectFile(response.json(), key);
    });

    describe('PATCH junction exercise', () => {
      async function setupJunction() {
        const trainer = await h.createTrainer();
        const template = (await createTemplate(trainer.accessToken)).json();
        const training = (await createTrainingTemplate(trainer.accessToken, {
          exerciseTemplates: [{ exerciseTemplateId: template.id }],
        })).json();
        const junction = training.trainingTemplateExerciseTemplates[0];
        return {
          trainer,
          url: `/trainer/training-templates/${training.id}/exercises/${junction.id}`,
        };
      }

      it('sets, keeps and clears videoFileKey', async () => {
        const { trainer, url } = await setupJunction();
        const key = ownKey(trainer.trainerId);
        const patch = (payload) => app.inject({ method: 'PATCH', url, headers: auth(trainer.accessToken), payload });

        const set = await patch({ videoFileKey: key });
        const kept = await patch({ sets: 4 });
        const cleared = await patch({ videoFileKey: null });

        expectFile(set.json(), key);
        expectFile(kept.json(), key);
        expectFile(cleared.json(), null);
      });

      it('rejects a foreign key', async () => {
        const { trainer, url } = await setupJunction();
        const other = await h.createTrainer();

        const response = await app.inject({
          method: 'PATCH',
          url,
          headers: auth(trainer.accessToken),
          payload: { videoFileKey: ownKey(other.trainerId) },
        });

        expectInvalidKeyContract(response);
      });
    });
  });

  describe('POST /trainer/protocols/with-trainings (criteria 2, 3)', () => {
    async function postProtocol(exercisesFor) {
      const trainer = await h.createTrainer();
      const student = await h.createStudent();
      await h.linkStudent(trainer.trainerId, student.userId);
      const response = await app.inject({
        method: 'POST',
        url: '/trainer/protocols/with-trainings',
        headers: auth(trainer.accessToken),
        payload: {
          assigneeId: student.userId,
          name: 'Video Bulk Protocol',
          startDate: '2026-01-01',
          trainings: [{ name: 'Treino A', category: 'strength', order: 0, exercises: exercisesFor(trainer) }],
        },
      });
      return { trainer, response };
    }

    it('persists nested exercise videoFileKey (set and omitted)', async () => {
      const key = crypto.randomUUID();
      const { trainer, response } = await postProtocol((t) => [
        { name: 'Agachamento', type: 'strength', order: 0, sets: 3, videoFileKey: `${KEY_PREFIX}${t.trainerId}/${key}.mp4` },
        { name: 'Afundo', type: 'strength', order: 1, sets: 3 },
      ]);

      expect(response.statusCode).toBe(201);
      const stored = await prisma.exercise.findMany({
        where: { trainingId: response.json().trainings[0].id },
        orderBy: { order: 'asc' },
        select: { name: true, videoFileKey: true },
      });
      expect(stored).toEqual([
        { name: 'Agachamento', videoFileKey: `${KEY_PREFIX}${trainer.trainerId}/${key}.mp4` },
        { name: 'Afundo', videoFileKey: null },
      ]);
    });

    it('rejects a foreign nested key', async () => {
      const other = await h.createTrainer();

      const { response } = await postProtocol(() => [
        { name: 'Agachamento', type: 'strength', order: 0, sets: 3, videoFileKey: ownKey(other.trainerId) },
      ]);

      expectInvalidKeyContract(response);
    });
  });

  describe('student read paths (criterion 3)', () => {
    // why: seeds through Prisma so the read path is verified independently of every write path.
    async function setupStudentWorkout() {
      const trainer = await h.createTrainer();
      const student = await h.createStudent();
      await h.linkStudent(trainer.trainerId, student.userId);
      const protocol = await prisma.trainingProtocol.create({
        data: {
          trainerId: trainer.trainerId,
          assigneeId: student.userId,
          name: 'Video Protocol',
          status: 'active',
          startDate: new Date('2025-01-01'),
        },
      });
      const training = await prisma.training.create({
        data: {
          trainingProtocolId: protocol.id,
          name: 'Today Training',
          category: 'strength',
          weekDay: todayWeekday(),
          order: 0,
        },
      });
      const key = ownKey(trainer.trainerId);
      await prisma.exercise.create({
        data: { trainingId: training.id, name: 'With file', type: 'strength', order: 0, sets: 3, videoFileKey: key },
      });
      await prisma.exercise.create({
        data: { trainingId: training.id, name: 'Without file', type: 'strength', order: 1, sets: 3 },
      });
      return { student, training, key };
    }

    function byName(exercises) {
      return Object.fromEntries(exercises.map((e) => [e.name, e]));
    }

    it('GET /my/workouts/today returns the file fields on targetTraining exercises', async () => {
      const { student, key } = await setupStudentWorkout();

      const response = await app.inject({
        method: 'GET',
        url: '/my/workouts/today',
        headers: { ...auth(student.accessToken), 'app-timezone': 'UTC' },
      });

      expect(response.statusCode).toBe(200);
      const exercises = byName(response.json().workouts[0].targetTraining.exercises);
      expectFile(exercises['With file'], key);
      expectFile(exercises['Without file'], null);
    });

    it('GET /my/trainings/:trainingId/exercises returns the file fields', async () => {
      const { student, training, key } = await setupStudentWorkout();

      const response = await app.inject({
        method: 'GET',
        url: `/my/trainings/${training.id}/exercises`,
        headers: auth(student.accessToken),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      const exercises = byName(body.items ?? body.data ?? body);
      expectFile(exercises['With file'], key);
      expectFile(exercises['Without file'], null);
    });

    it('GET /my/workout-sessions/:id returns the file fields on exerciseLogs[].exercise', async () => {
      const { student, training, key } = await setupStudentWorkout();
      const started = await h.startSession(student.accessToken, training.id);
      expect(started.statusCode).toBe(201);

      const response = await app.inject({
        method: 'GET',
        url: `/my/workout-sessions/${started.json().id}`,
        headers: auth(student.accessToken),
      });

      expect(response.statusCode).toBe(200);
      const exercises = byName(response.json().exerciseLogs.map((log) => log.exercise));
      expectFile(exercises['With file'], key);
      expectFile(exercises['Without file'], null);
    });
  });
});
