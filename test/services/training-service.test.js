import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    trainer: { findUnique: vi.fn() },
    training: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    trainingProtocol: { findUnique: vi.fn() },
    trainingTemplate: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { prisma } from '../../src/db.js';
import {
  getTrainingById,
  updateTraining,
  deleteTraining,
} from '../../src/services/training-service.js';

const makeTraining = (overrides = {}) => ({
  id: 'tr1',
  trainingProtocolId: 'p1',
  name: 'Training A',
  deletedAt: null,
  trainingProtocol: {
    id: 'p1',
    trainerId: 't1',
    assigneeId: 'u-student',
    deletedAt: null,
  },
  ...overrides,
});

describe('training-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getTrainingById', () => {
    it('throws TRAINING_NOT_FOUND when training does not exist', async () => {
      prisma.training.findUnique.mockResolvedValue(null);

      await expect(getTrainingById('u1', 'tr1', 'trainer')).rejects.toMatchObject({
        code: 'TRAINING_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws TRAINING_NOT_FOUND when training is soft-deleted', async () => {
      prisma.training.findUnique.mockResolvedValue(makeTraining({ deletedAt: new Date() }));

      await expect(getTrainingById('u1', 'tr1', 'trainer')).rejects.toMatchObject({
        code: 'TRAINING_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws TRAINING_NOT_FOUND when parent protocol is soft-deleted', async () => {
      prisma.training.findUnique.mockResolvedValue(
        makeTraining({
          trainingProtocol: { id: 'p1', trainerId: 't1', assigneeId: 'u-student', deletedAt: new Date() },
        }),
      );

      await expect(getTrainingById('u1', 'tr1', 'trainer')).rejects.toMatchObject({
        code: 'TRAINING_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws TRAINER_PROFILE_MISSING when trainer profile does not exist', async () => {
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      prisma.trainer.findUnique.mockResolvedValue(null);

      await expect(getTrainingById('u1', 'tr1', 'trainer')).rejects.toMatchObject({
        code: 'TRAINER_PROFILE_MISSING',
        statusCode: 404,
      });
    });

    it('throws FORBIDDEN_NOT_PROTOCOL_OWNER when trainer does not own the training', async () => {
      prisma.training.findUnique.mockResolvedValue(
        makeTraining({
          trainingProtocol: { id: 'p1', trainerId: 'other-trainer', assigneeId: 'u-student', deletedAt: null },
        }),
      );
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });

      await expect(getTrainingById('u1', 'tr1', 'trainer')).rejects.toMatchObject({
        code: 'FORBIDDEN_NOT_PROTOCOL_OWNER',
        statusCode: 403,
      });
    });

    it('throws FORBIDDEN_NOT_YOUR_TRAINING when student is not the assignee', async () => {
      prisma.training.findUnique.mockResolvedValue(
        makeTraining({
          trainingProtocol: { id: 'p1', trainerId: 't1', assigneeId: 'other-user', deletedAt: null },
        }),
      );

      await expect(getTrainingById('u1', 'tr1', 'assignee')).rejects.toMatchObject({
        code: 'FORBIDDEN_NOT_YOUR_TRAINING',
        statusCode: 403,
      });
    });

    it('returns training when trainer owns it', async () => {
      const training = makeTraining();
      prisma.training.findUnique.mockResolvedValue(training);
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });

      const result = await getTrainingById('u1', 'tr1', 'trainer');

      expect(result).toEqual(training);
    });

    it('returns training when student is the assignee', async () => {
      const training = makeTraining();
      prisma.training.findUnique.mockResolvedValue(training);

      const result = await getTrainingById('u-student', 'tr1', 'assignee');

      expect(result).toEqual(training);
    });
  });

  describe('updateTraining', () => {
    it('throws TRAINER_PROFILE_MISSING when trainer does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue(null);

      await expect(updateTraining('u1', 'tr1', { name: 'New' })).rejects.toMatchObject({
        code: 'TRAINER_PROFILE_MISSING',
        statusCode: 404,
      });
      expect(prisma.training.findUnique).not.toHaveBeenCalled();
    });

    it('throws TRAINING_NOT_FOUND when training does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(null);

      await expect(updateTraining('u1', 'tr1', { name: 'New' })).rejects.toMatchObject({
        code: 'TRAINING_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws TRAINING_NOT_FOUND when training is soft-deleted', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining({ deletedAt: new Date() }));

      await expect(updateTraining('u1', 'tr1', { name: 'New' })).rejects.toMatchObject({
        code: 'TRAINING_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws TRAINING_NOT_FOUND when parent protocol is soft-deleted', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(
        makeTraining({
          trainingProtocol: { id: 'p1', trainerId: 't1', deletedAt: new Date() },
        }),
      );

      await expect(updateTraining('u1', 'tr1', { name: 'New' })).rejects.toMatchObject({
        code: 'TRAINING_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws FORBIDDEN_NOT_PROTOCOL_OWNER when trainer does not own training', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(
        makeTraining({
          trainingProtocol: { id: 'p1', trainerId: 'other-trainer', deletedAt: null },
        }),
      );

      await expect(updateTraining('u1', 'tr1', { name: 'New' })).rejects.toMatchObject({
        code: 'FORBIDDEN_NOT_PROTOCOL_OWNER',
        statusCode: 403,
      });
    });

    it('updates and returns training', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      const updated = makeTraining({ name: 'New Name' });
      prisma.training.update.mockResolvedValue(updated);

      const result = await updateTraining('u1', 'tr1', { name: 'New Name' });

      expect(result).toEqual(updated);
      expect(prisma.training.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'tr1' },
          data: expect.objectContaining({ name: 'New Name' }),
        }),
      );
    });
  });

  describe('deleteTraining', () => {
    it('throws TRAINER_PROFILE_MISSING when trainer does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue(null);

      await expect(deleteTraining('u1', 'tr1')).rejects.toMatchObject({
        code: 'TRAINER_PROFILE_MISSING',
        statusCode: 404,
      });
    });

    it('throws TRAINING_NOT_FOUND when training does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(null);

      await expect(deleteTraining('u1', 'tr1')).rejects.toMatchObject({
        code: 'TRAINING_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws TRAINING_NOT_FOUND when training is soft-deleted', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining({ deletedAt: new Date() }));

      await expect(deleteTraining('u1', 'tr1')).rejects.toMatchObject({
        code: 'TRAINING_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws TRAINING_NOT_FOUND when parent protocol is soft-deleted', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(
        makeTraining({
          trainingProtocol: { id: 'p1', trainerId: 't1', deletedAt: new Date() },
        }),
      );

      await expect(deleteTraining('u1', 'tr1')).rejects.toMatchObject({
        code: 'TRAINING_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws FORBIDDEN_NOT_PROTOCOL_OWNER when trainer does not own training', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(
        makeTraining({
          trainingProtocol: { id: 'p1', trainerId: 'other-trainer', deletedAt: null },
        }),
      );

      await expect(deleteTraining('u1', 'tr1')).rejects.toMatchObject({
        code: 'FORBIDDEN_NOT_PROTOCOL_OWNER',
        statusCode: 403,
      });
    });

    it('soft deletes training', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      const deleted = makeTraining({ deletedAt: new Date() });
      prisma.training.update.mockResolvedValue(deleted);

      const result = await deleteTraining('u1', 'tr1');

      expect(result).toEqual(deleted);
      expect(prisma.training.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'tr1' },
          data: expect.objectContaining({ deletedAt: expect.any(Date) }),
        }),
      );
    });
  });

});

