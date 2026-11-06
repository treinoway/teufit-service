import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  createFeedback,
  listFeedbacks,
  updateFeedbackStatus,
} from '../../src/services/trainer-feedback-service.js';
import { FEEDBACK_CATEGORIES, FEEDBACK_STATUSES } from '../../src/constants/feedback.js';
import { AppError } from '../../src/errors/app-error.js';

const USER_ID = 'user-1';
const TRAINER_ID = 'trainer-1';
const FEEDBACK_ID = 'feedback-1';
const NOT_FOUND_STATUS = 404;
const FEEDBACK_NOT_FOUND = 'FEEDBACK_NOT_FOUND';
const NOT_FOUND_MESSAGE_CODE = 'resource.notFound';
const USER_AGENT = 'Mozilla/5.0 (test)';
const CREATED_AT = new Date('2026-11-01T10:00:00.000Z');

const validInput = {
  category: FEEDBACK_CATEGORIES.SUGGESTION,
  message: 'Gostaria de duplicar treinos',
  pagePath: '/trainer/students',
  viewport: '1280x720',
};

// Builds a Prisma stub exposing the trainer and trainerFeedback methods the service uses.
function makeDb() {
  return {
    trainer: { findUnique: vi.fn() },
    trainerFeedback: {
      create: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  };
}

// Builds a trainerFeedback row with its trainer relation, overridable per test.
function makeRow(overrides = {}) {
  return {
    id: FEEDBACK_ID,
    category: FEEDBACK_CATEGORIES.BUG,
    message: 'Quebrou',
    pagePath: '/x',
    viewport: '390x844',
    userAgent: USER_AGENT,
    status: FEEDBACK_STATUSES.NEW,
    createdAt: CREATED_AT,
    readAt: null,
    trainer: {
      id: TRAINER_ID,
      user: { firstName: 'Ana', lastName: 'Silva', email: 'ana@example.com' },
      platformSubscription: { tier: 'BETA' },
    },
    ...overrides,
  };
}

describe('trainer-feedback-service', () => {
  let db;

  beforeEach(() => {
    db = makeDb();
  });

  describe('createFeedback', () => {
    beforeEach(() => {
      db.trainer.findUnique.mockResolvedValue({ id: TRAINER_ID });
      db.trainerFeedback.create.mockResolvedValue({ id: FEEDBACK_ID, createdAt: CREATED_AT });
    });

    it('should return only id and createdAt', async () => {
      const result = await createFeedback(db, USER_ID, validInput, { userAgent: USER_AGENT });

      expect(result).toEqual({ id: FEEDBACK_ID, createdAt: CREATED_AT });
    });

    it('should resolve the trainer from the user id', async () => {
      await createFeedback(db, USER_ID, validInput, { userAgent: USER_AGENT });

      expect(db.trainer.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: USER_ID } }),
      );
    });

    it('should persist trainerId, input fields and the user agent', async () => {
      await createFeedback(db, USER_ID, validInput, { userAgent: USER_AGENT });

      expect(db.trainerFeedback.create).toHaveBeenCalledTimes(1);
      expect(db.trainerFeedback.create.mock.calls[0][0].data).toMatchObject({
        trainerId: TRAINER_ID,
        category: FEEDBACK_CATEGORIES.SUGGESTION,
        message: validInput.message,
        pagePath: validInput.pagePath,
        viewport: validInput.viewport,
        userAgent: USER_AGENT,
      });
    });

    it('should trim surrounding whitespace from the message', async () => {
      await createFeedback(db, USER_ID, { ...validInput, message: '  olá mundo \n' }, { userAgent: USER_AGENT });

      expect(db.trainerFeedback.create.mock.calls[0][0].data.message).toBe('olá mundo');
    });

    it('should store null for omitted optional fields', async () => {
      await createFeedback(db, USER_ID, { category: FEEDBACK_CATEGORIES.PRAISE, message: 'Ótimo' }, {});

      expect(db.trainerFeedback.create.mock.calls[0][0].data).toMatchObject({
        pagePath: null,
        viewport: null,
        userAgent: null,
      });
    });

    it('should throw 404 AppError and save nothing when the user has no trainer profile', async () => {
      db.trainer.findUnique.mockResolvedValue(null);

      const promise = createFeedback(db, USER_ID, validInput, { userAgent: USER_AGENT });

      await expect(promise).rejects.toBeInstanceOf(AppError);
      await expect(promise).rejects.toMatchObject({ httpStatus: NOT_FOUND_STATUS });
      expect(db.trainerFeedback.create).not.toHaveBeenCalled();
    });

    it('should reject a whitespace-only message without saving', async () => {
      const promise = createFeedback(db, USER_ID, { ...validInput, message: '   \n\t ' }, {});

      await expect(promise).rejects.toBeInstanceOf(AppError);
      expect(db.trainerFeedback.create).not.toHaveBeenCalled();
    });
  });

  describe('listFeedbacks', () => {
    beforeEach(() => {
      db.trainerFeedback.findMany.mockResolvedValue([makeRow()]);
      db.trainerFeedback.count.mockResolvedValue(1);
    });

    it('should return items with trainer name, email and tier plus pagination metadata', async () => {
      const result = await listFeedbacks(db, { page: 1, pageSize: 20 });

      expect(result).toEqual({
        items: [
          {
            id: FEEDBACK_ID,
            category: FEEDBACK_CATEGORIES.BUG,
            message: 'Quebrou',
            pagePath: '/x',
            viewport: '390x844',
            userAgent: USER_AGENT,
            status: FEEDBACK_STATUSES.NEW,
            createdAt: CREATED_AT,
            readAt: null,
            trainer: { id: TRAINER_ID, name: 'Ana Silva', email: 'ana@example.com', tier: 'BETA' },
          },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
      });
    });

    it('should report tier FREE when the trainer has no platform subscription', async () => {
      const row = makeRow();
      row.trainer.platformSubscription = null;
      db.trainerFeedback.findMany.mockResolvedValue([row]);

      const result = await listFeedbacks(db, { page: 1, pageSize: 20 });

      expect(result.items[0].trainer.tier).toBe('FREE');
    });

    it('should return an empty list with total 0 when nothing matches', async () => {
      db.trainerFeedback.findMany.mockResolvedValue([]);
      db.trainerFeedback.count.mockResolvedValue(0);

      const result = await listFeedbacks(db, { page: 1, pageSize: 20 });

      expect(result).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
    });

    it('should apply skip and take from page and pageSize', async () => {
      await listFeedbacks(db, { page: 3, pageSize: 10 });

      expect(db.trainerFeedback.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 10 }),
      );
    });

    it('should filter by status when provided', async () => {
      await listFeedbacks(db, { status: FEEDBACK_STATUSES.READ, page: 1, pageSize: 20 });

      expect(db.trainerFeedback.findMany.mock.calls[0][0].where).toMatchObject({
        status: FEEDBACK_STATUSES.READ,
      });
    });

    it('should filter by category when provided', async () => {
      await listFeedbacks(db, { category: FEEDBACK_CATEGORIES.PRAISE, page: 1, pageSize: 20 });

      expect(db.trainerFeedback.findMany.mock.calls[0][0].where).toMatchObject({
        category: FEEDBACK_CATEGORIES.PRAISE,
      });
    });

    it('should not constrain status or category when filters are omitted', async () => {
      await listFeedbacks(db, { page: 1, pageSize: 20 });

      const where = db.trainerFeedback.findMany.mock.calls[0][0].where ?? {};
      expect(where).not.toHaveProperty('status');
      expect(where).not.toHaveProperty('category');
    });

    it('should count with the same filter used for the page', async () => {
      await listFeedbacks(db, { status: FEEDBACK_STATUSES.NEW, page: 1, pageSize: 20 });

      expect(db.trainerFeedback.count).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: FEEDBACK_STATUSES.NEW }) }),
      );
    });

    it('should order newest first', async () => {
      await listFeedbacks(db, { page: 1, pageSize: 20 });

      const { orderBy } = db.trainerFeedback.findMany.mock.calls[0][0];
      expect(JSON.stringify(orderBy)).toContain('"createdAt":"desc"');
    });
  });

  describe('updateFeedbackStatus', () => {
    beforeEach(() => {
      db.trainerFeedback.findUnique.mockResolvedValue({ id: FEEDBACK_ID });
      db.trainerFeedback.update.mockImplementation(async ({ data }) =>
        makeRow({ status: data.status, readAt: data.readAt }),
      );
    });

    it('should set status READ and a readAt date when marking as read', async () => {
      const result = await updateFeedbackStatus(db, FEEDBACK_ID, FEEDBACK_STATUSES.READ);

      expect(result.status).toBe(FEEDBACK_STATUSES.READ);
      expect(db.trainerFeedback.update.mock.calls[0][0].data.readAt).toBeInstanceOf(Date);
    });

    it('should set status NEW and clear readAt when marking as new', async () => {
      const result = await updateFeedbackStatus(db, FEEDBACK_ID, FEEDBACK_STATUSES.NEW);

      expect(result.status).toBe(FEEDBACK_STATUSES.NEW);
      expect(db.trainerFeedback.update.mock.calls[0][0].data.readAt).toBeNull();
    });

    it('should update the row matching the given id', async () => {
      await updateFeedbackStatus(db, FEEDBACK_ID, FEEDBACK_STATUSES.READ);

      expect(db.trainerFeedback.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: FEEDBACK_ID } }),
      );
    });

    it('should return the list item shape with trainer info', async () => {
      const result = await updateFeedbackStatus(db, FEEDBACK_ID, FEEDBACK_STATUSES.READ);

      expect(result.trainer).toEqual({ id: TRAINER_ID, name: 'Ana Silva', email: 'ana@example.com', tier: 'BETA' });
    });

    it('should throw FEEDBACK_NOT_FOUND 404 resource.notFound for an unknown id', async () => {
      db.trainerFeedback.findUnique.mockResolvedValue(null);
      db.trainerFeedback.update.mockRejectedValue(Object.assign(new Error('missing'), { code: 'P2025' }));

      const promise = updateFeedbackStatus(db, 'missing-id', FEEDBACK_STATUSES.READ);

      await expect(promise).rejects.toBeInstanceOf(AppError);
      await expect(promise).rejects.toMatchObject({
        httpStatus: NOT_FOUND_STATUS,
        error: FEEDBACK_NOT_FOUND,
        messageCode: NOT_FOUND_MESSAGE_CODE,
      });
    });
  });
});
