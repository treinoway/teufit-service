import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { provisionTrainerPlan } from '../helpers/platform-plan.js';
import {
  createAdminWithToken,
  createTrainerWithToken,
  createStudentWithToken,
} from '../helpers/admin-users.js';
import { prisma } from '../../src/db.js';
import { FEEDBACK_CATEGORIES, FEEDBACK_STATUSES } from '../../src/constants/feedback.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const OK_STATUS = 200;
const BAD_REQUEST_STATUS = 400;
const UNAUTHORIZED_STATUS = 401;
const FORBIDDEN_STATUS = 403;
const NOT_FOUND_STATUS = 404;
const UNKNOWN_FEEDBACK_ID = '00000000-0000-4000-8000-000000000000';
const BETA_TIER = 'BETA';
const FREE_TIER = 'FREE';
const BASE_TIME = Date.UTC(2026, 10, 1);
const MINUTE_MS = 60_000;

e2eDescribe('e2e: admin trainer feedback', () => {
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

  function authHeader(accessToken) {
    return accessToken ? { authorization: `Bearer ${accessToken}` } : {};
  }

  function listFeedbacks(accessToken, query = '', extraHeaders = {}) {
    return app.inject({
      method: 'GET',
      url: `/admin/feedbacks${query}`,
      headers: { ...authHeader(accessToken), ...extraHeaders },
    });
  }

  function patchFeedback(accessToken, id, payload) {
    return app.inject({
      method: 'PATCH',
      url: `/admin/feedbacks/${id}`,
      headers: authHeader(accessToken),
      payload,
    });
  }

  function expectErrorContract(body, { error, messageCode }) {
    expect(body).toMatchObject({ error, messageCode, message: expect.any(String) });
    expect(body).toHaveProperty('details');
  }

  function seedFeedback(trainerId, overrides = {}) {
    return prisma.trainerFeedback.create({
      data: {
        trainerId,
        category: FEEDBACK_CATEGORIES.SUGGESTION,
        message: 'mensagem',
        pagePath: '/trainer/students',
        viewport: '1280x720',
        userAgent: 'seed-agent',
        ...overrides,
      },
    });
  }

  function minutesAfterBase(minutes) {
    return new Date(BASE_TIME + minutes * MINUTE_MS);
  }

  describe('GET /admin/feedbacks access control', () => {
    it('returns 401 without a token', async () => {
      const response = await listFeedbacks(null);

      expect(response.statusCode).toBe(UNAUTHORIZED_STATUS);
    });

    it('returns 403 auth.forbidden to a trainer', async () => {
      const { accessToken } = await createTrainerWithToken(app);

      const response = await listFeedbacks(accessToken);

      expect(response.statusCode).toBe(FORBIDDEN_STATUS);
      expectErrorContract(response.json(), { error: 'FORBIDDEN', messageCode: 'auth.forbidden' });
    });

    it('returns 403 to a student', async () => {
      const { accessToken } = await createStudentWithToken(app);

      const response = await listFeedbacks(accessToken);

      expect(response.statusCode).toBe(FORBIDDEN_STATUS);
    });
  });

  describe('GET /admin/feedbacks', () => {
    it('returns an empty page when there is no feedback', async () => {
      const { accessToken } = await createAdminWithToken(app);

      const response = await listFeedbacks(accessToken);

      expect(response.statusCode).toBe(OK_STATUS);
      expect(response.json()).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
    });

    it('returns the full item shape with trainer identity and categoryLabel', async () => {
      const { accessToken } = await createAdminWithToken(app);
      const trainer = await createTrainerWithToken(app, { firstName: 'Ana', lastName: 'Silva' });
      const seeded = await seedFeedback(trainer.trainerId, { category: FEEDBACK_CATEGORIES.BUG });

      const response = await listFeedbacks(accessToken);

      expect(response.json().items[0]).toMatchObject({
        id: seeded.id,
        category: FEEDBACK_CATEGORIES.BUG,
        categoryLabel: expect.any(String),
        message: 'mensagem',
        pagePath: '/trainer/students',
        viewport: '1280x720',
        userAgent: 'seed-agent',
        status: FEEDBACK_STATUSES.NEW,
        createdAt: seeded.createdAt.toISOString(),
        readAt: null,
        trainer: { id: trainer.trainerId, name: 'Ana Silva', email: trainer.email, tier: FREE_TIER },
      });
    });

    it('reports the trainer tier from the platform subscription', async () => {
      const { accessToken } = await createAdminWithToken(app);
      const trainer = await createTrainerWithToken(app);
      await provisionTrainerPlan(trainer.trainerId, BETA_TIER);
      await seedFeedback(trainer.trainerId);

      const response = await listFeedbacks(accessToken);

      expect(response.json().items[0].trainer.tier).toBe(BETA_TIER);
    });

    it('returns pt-BR categoryLabel by default and en-US when requested', async () => {
      const { accessToken } = await createAdminWithToken(app);
      const trainer = await createTrainerWithToken(app);
      await seedFeedback(trainer.trainerId, { category: FEEDBACK_CATEGORIES.PRAISE });

      const ptResponse = await listFeedbacks(accessToken);
      const enResponse = await listFeedbacks(accessToken, '', { 'app-language': 'en-US' });

      expect(ptResponse.json().items[0].categoryLabel).not.toBe(enResponse.json().items[0].categoryLabel);
    });

    it('orders items newest first', async () => {
      const { accessToken } = await createAdminWithToken(app);
      const trainer = await createTrainerWithToken(app);
      const oldest = await seedFeedback(trainer.trainerId, { createdAt: minutesAfterBase(0) });
      const newest = await seedFeedback(trainer.trainerId, { createdAt: minutesAfterBase(20) });
      const middle = await seedFeedback(trainer.trainerId, { createdAt: minutesAfterBase(10) });

      const response = await listFeedbacks(accessToken);

      expect(response.json().items.map((item) => item.id)).toEqual([newest.id, middle.id, oldest.id]);
    });

    it('filters by status', async () => {
      const { accessToken } = await createAdminWithToken(app);
      const trainer = await createTrainerWithToken(app);
      await seedFeedback(trainer.trainerId, { status: FEEDBACK_STATUSES.NEW });
      const read = await seedFeedback(trainer.trainerId, { status: FEEDBACK_STATUSES.READ, readAt: new Date() });

      const response = await listFeedbacks(accessToken, `?status=${FEEDBACK_STATUSES.READ}`);

      expect(response.json().items.map((item) => item.id)).toEqual([read.id]);
      expect(response.json().total).toBe(1);
    });

    it('filters by category', async () => {
      const { accessToken } = await createAdminWithToken(app);
      const trainer = await createTrainerWithToken(app);
      await seedFeedback(trainer.trainerId, { category: FEEDBACK_CATEGORIES.BUG });
      const praise = await seedFeedback(trainer.trainerId, { category: FEEDBACK_CATEGORIES.PRAISE });

      const response = await listFeedbacks(accessToken, `?category=${FEEDBACK_CATEGORIES.PRAISE}`);

      expect(response.json().items.map((item) => item.id)).toEqual([praise.id]);
    });

    it('combines status and category filters', async () => {
      const { accessToken } = await createAdminWithToken(app);
      const trainer = await createTrainerWithToken(app);
      await seedFeedback(trainer.trainerId, { category: FEEDBACK_CATEGORIES.BUG, status: FEEDBACK_STATUSES.READ, readAt: new Date() });
      const match = await seedFeedback(trainer.trainerId, { category: FEEDBACK_CATEGORIES.BUG, status: FEEDBACK_STATUSES.NEW });
      await seedFeedback(trainer.trainerId, { category: FEEDBACK_CATEGORIES.PRAISE, status: FEEDBACK_STATUSES.NEW });

      const response = await listFeedbacks(accessToken, `?status=${FEEDBACK_STATUSES.NEW}&category=${FEEDBACK_CATEGORIES.BUG}`);

      expect(response.json().items.map((item) => item.id)).toEqual([match.id]);
    });

    it('paginates with total counting every match', async () => {
      const { accessToken } = await createAdminWithToken(app);
      const trainer = await createTrainerWithToken(app);
      const seeded = [];
      for (let index = 0; index < 5; index += 1) {
        seeded.push(await seedFeedback(trainer.trainerId, { createdAt: minutesAfterBase(index) }));
      }

      const response = await listFeedbacks(accessToken, '?page=2&pageSize=2');

      expect(response.json()).toMatchObject({ total: 5, page: 2, pageSize: 2 });
      expect(response.json().items.map((item) => item.id)).toEqual([seeded[2].id, seeded[1].id]);
    });

    it('returns 400 for a pageSize above 100', async () => {
      const { accessToken } = await createAdminWithToken(app);

      const response = await listFeedbacks(accessToken, '?pageSize=101');

      expect(response.statusCode).toBe(BAD_REQUEST_STATUS);
      expectErrorContract(response.json(), { error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });

    it('returns 400 for an unknown status filter', async () => {
      const { accessToken } = await createAdminWithToken(app);

      const response = await listFeedbacks(accessToken, '?status=ARCHIVED');

      expect(response.statusCode).toBe(BAD_REQUEST_STATUS);
    });

    it('returns 400 for an unknown category filter', async () => {
      const { accessToken } = await createAdminWithToken(app);

      const response = await listFeedbacks(accessToken, '?category=COMPLAINT');

      expect(response.statusCode).toBe(BAD_REQUEST_STATUS);
    });
  });

  describe('PATCH /admin/feedbacks/:id access control', () => {
    it('returns 401 without a token', async () => {
      const response = await patchFeedback(null, UNKNOWN_FEEDBACK_ID, { status: FEEDBACK_STATUSES.READ });

      expect(response.statusCode).toBe(UNAUTHORIZED_STATUS);
    });

    it('returns 403 to a trainer and leaves the row unchanged', async () => {
      const trainer = await createTrainerWithToken(app);
      const seeded = await seedFeedback(trainer.trainerId);

      const response = await patchFeedback(trainer.accessToken, seeded.id, { status: FEEDBACK_STATUSES.READ });

      expect(response.statusCode).toBe(FORBIDDEN_STATUS);
      const row = await prisma.trainerFeedback.findUnique({ where: { id: seeded.id } });
      expect(row.status).toBe(FEEDBACK_STATUSES.NEW);
    });
  });

  describe('PATCH /admin/feedbacks/:id', () => {
    it('marks as READ, sets readAt and returns the item', async () => {
      const { accessToken } = await createAdminWithToken(app);
      const trainer = await createTrainerWithToken(app);
      const seeded = await seedFeedback(trainer.trainerId);

      const response = await patchFeedback(accessToken, seeded.id, { status: FEEDBACK_STATUSES.READ });

      expect(response.statusCode).toBe(OK_STATUS);
      expect(response.json()).toMatchObject({
        id: seeded.id,
        status: FEEDBACK_STATUSES.READ,
        readAt: expect.any(String),
        categoryLabel: expect.any(String),
        trainer: { id: trainer.trainerId },
      });
      const row = await prisma.trainerFeedback.findUnique({ where: { id: seeded.id } });
      expect(row.readAt).toBeInstanceOf(Date);
    });

    it('marks as NEW again and clears readAt', async () => {
      const { accessToken } = await createAdminWithToken(app);
      const trainer = await createTrainerWithToken(app);
      const seeded = await seedFeedback(trainer.trainerId, { status: FEEDBACK_STATUSES.READ, readAt: new Date() });

      const response = await patchFeedback(accessToken, seeded.id, { status: FEEDBACK_STATUSES.NEW });

      expect(response.statusCode).toBe(OK_STATUS);
      expect(response.json()).toMatchObject({ status: FEEDBACK_STATUSES.NEW, readAt: null });
      const row = await prisma.trainerFeedback.findUnique({ where: { id: seeded.id } });
      expect(row.readAt).toBeNull();
    });

    it('returns 404 FEEDBACK_NOT_FOUND resource.notFound for an unknown id', async () => {
      const { accessToken } = await createAdminWithToken(app);

      const response = await patchFeedback(accessToken, UNKNOWN_FEEDBACK_ID, { status: FEEDBACK_STATUSES.READ });

      expect(response.statusCode).toBe(NOT_FOUND_STATUS);
      expectErrorContract(response.json(), { error: 'FEEDBACK_NOT_FOUND', messageCode: 'resource.notFound' });
    });

    it('returns 400 for a status outside NEW/READ', async () => {
      const { accessToken } = await createAdminWithToken(app);
      const trainer = await createTrainerWithToken(app);
      const seeded = await seedFeedback(trainer.trainerId);

      const response = await patchFeedback(accessToken, seeded.id, { status: 'ARCHIVED' });

      expect(response.statusCode).toBe(BAD_REQUEST_STATUS);
      expectErrorContract(response.json(), { error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });

    it('returns 400 when status is missing', async () => {
      const { accessToken } = await createAdminWithToken(app);
      const trainer = await createTrainerWithToken(app);
      const seeded = await seedFeedback(trainer.trainerId);

      const response = await patchFeedback(accessToken, seeded.id, {});

      expect(response.statusCode).toBe(BAD_REQUEST_STATUS);
    });
  });
});
