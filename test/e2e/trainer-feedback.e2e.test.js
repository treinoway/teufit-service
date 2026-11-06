import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import {
  createAdminWithToken,
  createTrainerWithToken,
  createStudentWithToken,
} from '../helpers/admin-users.js';
import { prisma } from '../../src/db.js';
import { FEEDBACK_CATEGORIES, FEEDBACK_STATUSES } from '../../src/constants/feedback.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const CREATED_STATUS = 201;
const BAD_REQUEST_STATUS = 400;
const UNAUTHORIZED_STATUS = 401;
const FORBIDDEN_STATUS = 403;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_PAGE_PATH_LENGTH = 300;
const MAX_VIEWPORT_LENGTH = 20;
const MAX_USER_AGENT_LENGTH = 500;
const USER_AGENT = 'TreinowayE2E/1.0';

const validPayload = {
  category: FEEDBACK_CATEGORIES.SUGGESTION,
  message: 'Seria legal poder duplicar treinos',
  pagePath: '/trainer/students',
  viewport: '1280x720',
};

e2eDescribe('e2e: POST /trainer/feedback', () => {
  let app;

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  function postFeedback(accessToken, payload, extraHeaders = {}) {
    return app.inject({
      method: 'POST',
      url: '/trainer/feedback',
      headers: {
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        ...extraHeaders,
      },
      payload,
    });
  }

  function expectErrorContract(body, { error, messageCode }) {
    expect(body).toMatchObject({ error, messageCode, message: expect.any(String) });
    expect(body).toHaveProperty('details');
  }

  async function expectValidationFailure(payload) {
    const { accessToken } = await createTrainerWithToken(app);

    const response = await postFeedback(accessToken, payload);

    expect(response.statusCode).toBe(BAD_REQUEST_STATUS);
    expectErrorContract(response.json(), { error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    expect(await prisma.trainerFeedback.count()).toBe(0);
  }

  describe('access control', () => {
    it('returns 401 without a token and saves nothing', async () => {
      const response = await postFeedback(null, validPayload);

      expect(response.statusCode).toBe(UNAUTHORIZED_STATUS);
      expect(await prisma.trainerFeedback.count()).toBe(0);
    });

    it('returns 403 auth.forbidden to a student', async () => {
      const { accessToken } = await createStudentWithToken(app);

      const response = await postFeedback(accessToken, validPayload);

      expect(response.statusCode).toBe(FORBIDDEN_STATUS);
      expectErrorContract(response.json(), { error: 'FORBIDDEN', messageCode: 'auth.forbidden' });
    });

    it('returns 403 to an admin without the trainer role', async () => {
      const { accessToken } = await createAdminWithToken(app);

      const response = await postFeedback(accessToken, validPayload);

      expect(response.statusCode).toBe(FORBIDDEN_STATUS);
    });
  });

  describe('successful creation', () => {
    it('returns 201 with only id and createdAt', async () => {
      const { accessToken } = await createTrainerWithToken(app);

      const response = await postFeedback(accessToken, validPayload);

      expect(response.statusCode).toBe(CREATED_STATUS);
      expect(Object.keys(response.json()).sort()).toEqual(['createdAt', 'id']);
      expect(response.json().id).toEqual(expect.any(String));
    });

    it('persists the row with trainerId, status NEW and the payload fields', async () => {
      const { accessToken, trainerId } = await createTrainerWithToken(app);

      const response = await postFeedback(accessToken, validPayload);

      const row = await prisma.trainerFeedback.findUnique({ where: { id: response.json().id } });
      expect(row).toMatchObject({
        trainerId,
        category: FEEDBACK_CATEGORIES.SUGGESTION,
        message: validPayload.message,
        pagePath: validPayload.pagePath,
        viewport: validPayload.viewport,
        status: FEEDBACK_STATUSES.NEW,
        readAt: null,
      });
    });

    it('stores the user-agent request header', async () => {
      const { accessToken } = await createTrainerWithToken(app);

      const response = await postFeedback(accessToken, validPayload, { 'user-agent': USER_AGENT });

      const row = await prisma.trainerFeedback.findUnique({ where: { id: response.json().id } });
      expect(row.userAgent).toBe(USER_AGENT);
    });

    it('truncates the user-agent to 500 characters', async () => {
      const { accessToken } = await createTrainerWithToken(app);

      const response = await postFeedback(accessToken, validPayload, {
        'user-agent': 'a'.repeat(MAX_USER_AGENT_LENGTH + 100),
      });

      const row = await prisma.trainerFeedback.findUnique({ where: { id: response.json().id } });
      expect(row.userAgent).toHaveLength(MAX_USER_AGENT_LENGTH);
    });

    it('trims the message before saving', async () => {
      const { accessToken } = await createTrainerWithToken(app);

      const response = await postFeedback(accessToken, { ...validPayload, message: '  com espaços \n' });

      const row = await prisma.trainerFeedback.findUnique({ where: { id: response.json().id } });
      expect(row.message).toBe('com espaços');
    });

    it('accepts a body with only category and message', async () => {
      const { accessToken } = await createTrainerWithToken(app);

      const response = await postFeedback(accessToken, {
        category: FEEDBACK_CATEGORIES.PRAISE,
        message: 'Adorei',
      });

      expect(response.statusCode).toBe(CREATED_STATUS);
    });

    it('accepts a message of exactly 2000 characters', async () => {
      const { accessToken } = await createTrainerWithToken(app);

      const response = await postFeedback(accessToken, {
        ...validPayload,
        message: 'a'.repeat(MAX_MESSAGE_LENGTH),
      });

      expect(response.statusCode).toBe(CREATED_STATUS);
    });

    it.each(Object.values(FEEDBACK_CATEGORIES))('accepts category %s', async (category) => {
      const { accessToken } = await createTrainerWithToken(app);

      const response = await postFeedback(accessToken, { ...validPayload, category });

      expect(response.statusCode).toBe(CREATED_STATUS);
    });
  });

  describe('validation', () => {
    it('returns 400 for a category outside the allowed set', async () => {
      await expectValidationFailure({ ...validPayload, category: 'COMPLAINT' });
    });

    it('returns 400 when category is missing', async () => {
      await expectValidationFailure({ message: validPayload.message });
    });

    it('returns 400 when message is missing', async () => {
      await expectValidationFailure({ category: FEEDBACK_CATEGORIES.BUG });
    });

    it('returns 400 for an empty message', async () => {
      await expectValidationFailure({ ...validPayload, message: '' });
    });

    it('returns 400 for a whitespace-only message', async () => {
      await expectValidationFailure({ ...validPayload, message: '   \n\t  ' });
    });

    it('returns 400 for a message longer than 2000 characters', async () => {
      await expectValidationFailure({ ...validPayload, message: 'a'.repeat(MAX_MESSAGE_LENGTH + 1) });
    });

    it('returns 400 for a pagePath longer than 300 characters', async () => {
      await expectValidationFailure({ ...validPayload, pagePath: '/'.repeat(MAX_PAGE_PATH_LENGTH + 1) });
    });

    it('returns 400 for a viewport longer than 20 characters', async () => {
      await expectValidationFailure({ ...validPayload, viewport: '1'.repeat(MAX_VIEWPORT_LENGTH + 1) });
    });

    it('returns 400 for extra properties', async () => {
      await expectValidationFailure({ ...validPayload, status: FEEDBACK_STATUSES.READ });
    });
  });
});
