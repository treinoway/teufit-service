import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    trainer: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    trainingProtocol: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    trainingProtocolTemplate: { findUnique: vi.fn() },
  },
}));

import { prisma } from '../../src/db.js';
import {
  createProtocol,
  getProtocolsByTrainer,
  getMyProtocols,
  getProtocolById,
  updateProtocol,
  deleteProtocol,
  importFromTemplate,
} from '../../src/services/training-protocol-service.js';

describe('training-protocol-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createProtocol', () => {
    it('throws TRAINER_PROFILE_MISSING when trainer does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue(null);

      await expect(
        createProtocol('u1', {
          assigneeId: 'assignee-1',
          name: 'Protocol A',
          startDate: '2025-01-01',
        }),
      ).rejects.toMatchObject({
        code: 'TRAINER_PROFILE_MISSING',
        statusCode: 404,
      });

      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(prisma.trainingProtocol.create).not.toHaveBeenCalled();
    });

    it('throws ASSIGNEE_NOT_FOUND when assignee user does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        createProtocol('u1', {
          assigneeId: 'nonexistent',
          name: 'Protocol A',
          startDate: '2025-01-01',
        }),
      ).rejects.toMatchObject({
        code: 'ASSIGNEE_NOT_FOUND',
        statusCode: 404,
      });

      expect(prisma.trainingProtocol.create).not.toHaveBeenCalled();
    });

    it('throws ASSIGNEE_NOT_FOUND when assignee is soft-deleted', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.user.findUnique.mockResolvedValue({ id: 'assignee-1', deletedAt: new Date() });

      await expect(
        createProtocol('u1', {
          assigneeId: 'assignee-1',
          name: 'Protocol A',
          startDate: '2025-01-01',
        }),
      ).rejects.toMatchObject({
        code: 'ASSIGNEE_NOT_FOUND',
        statusCode: 404,
      });

      expect(prisma.trainingProtocol.create).not.toHaveBeenCalled();
    });

    it('throws INVALID_WEEK_DAYS when availableWeekDays contains invalid values', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.user.findUnique.mockResolvedValue({ id: 'assignee-1' });

      await expect(
        createProtocol('u1', {
          assigneeId: 'assignee-1',
          name: 'Protocol A',
          startDate: '2025-01-01',
          availableWeekDays: ['monday', 'invalid-day'],
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_WEEK_DAYS',
      });

      expect(prisma.trainingProtocol.create).not.toHaveBeenCalled();
    });

    it('throws INVALID_STATUS when status is invalid', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.user.findUnique.mockResolvedValue({ id: 'assignee-1' });

      await expect(
        createProtocol('u1', {
          assigneeId: 'assignee-1',
          name: 'Protocol A',
          startDate: '2025-01-01',
          status: 'invalid-status',
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_STATUS',
      });
    });

    it('creates protocol with assignee included', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.user.findUnique.mockResolvedValue({ id: 'assignee-1' });
      const created = {
        id: 'p1',
        trainerId: 't1',
        assigneeId: 'assignee-1',
        name: 'Protocol A',
        status: 'active',
        startDate: new Date('2025-01-01'),
        assignee: {
          id: 'assignee-1',
          firstName: 'John',
          lastName: 'Doe',
          avatarUrl: null,
        },
      };
      prisma.trainingProtocol.create.mockResolvedValue(created);

      const result = await createProtocol('u1', {
        assigneeId: 'assignee-1',
        name: 'Protocol A',
        startDate: '2025-01-01',
      });

      expect(result).toEqual({
        ...created,
        startDate: '2025-01-01',
      });
      expect(result.assignee).toMatchObject({
        id: 'assignee-1',
        firstName: 'John',
        lastName: 'Doe',
        avatarUrl: null,
      });
      expect(prisma.trainingProtocol.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            trainerId: 't1',
            assigneeId: 'assignee-1',
            name: 'Protocol A',
            status: 'active',
          }),
          include: expect.objectContaining({
            assignee: expect.any(Object),
          }),
        }),
      );
    });
  });

  describe('getProtocolsByTrainer', () => {
    it('throws TRAINER_PROFILE_MISSING when trainer does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue(null);

      await expect(getProtocolsByTrainer('u1')).rejects.toMatchObject({
        code: 'TRAINER_PROFILE_MISSING',
        statusCode: 404,
      });

      expect(prisma.trainingProtocol.findMany).not.toHaveBeenCalled();
    });

    it('returns protocols with assignee and filters by status/assigneeId', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      const protocols = [
        {
          id: 'p1',
          assigneeId: 'assignee-1',
          assignee: {
            id: 'assignee-1',
            firstName: 'John',
            lastName: 'Doe',
            avatarUrl: null,
          },
        },
      ];
      prisma.trainingProtocol.findMany.mockResolvedValue(protocols);

      const result = await getProtocolsByTrainer('u1', {
        status: 'active',
        assigneeId: 'assignee-1',
      });

      expect(result).toEqual(protocols);
      expect(result[0].assignee).toMatchObject({
        id: 'assignee-1',
        firstName: 'John',
        lastName: 'Doe',
      });
      expect(prisma.trainingProtocol.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            trainerId: 't1',
            status: 'active',
            assigneeId: 'assignee-1',
          }),
        }),
      );
    });
  });

  describe('getMyProtocols', () => {
    it('returns protocols assigned to user with trainer info', async () => {
      const protocols = [
        {
          id: 'p1',
          assigneeId: 'u1',
          trainer: { user: { firstName: 'Trainer', lastName: 'Name' } },
        },
      ];
      prisma.trainingProtocol.findMany.mockResolvedValue(protocols);

      const result = await getMyProtocols('u1');

      // Result should have trainer.user mapped to trainer
      expect(result).toEqual([
        {
          id: 'p1',
          assigneeId: 'u1',
          trainer: { firstName: 'Trainer', lastName: 'Name' },
        },
      ]);
      expect(prisma.trainingProtocol.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            assigneeId: 'u1',
            status: { in: ['active', 'completed'] },
          }),
        }),
      );
    });
  });

  describe('getProtocolById', () => {
    it('throws PROTOCOL_NOT_FOUND when protocol does not exist', async () => {
      prisma.trainingProtocol.findUnique.mockResolvedValue(null);

      await expect(
        getProtocolById('u1', 'p1', 'trainer'),
      ).rejects.toMatchObject({
        code: 'PROTOCOL_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws FORBIDDEN_NOT_PROTOCOL_OWNER when trainer does not own protocol', async () => {
      prisma.trainingProtocol.findUnique.mockResolvedValue({
        id: 'p1',
        trainerId: 'other-trainer',
        assigneeId: 'assignee-1',
        deletedAt: null,
      });
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });

      await expect(
        getProtocolById('u1', 'p1', 'trainer'),
      ).rejects.toMatchObject({
        code: 'FORBIDDEN_NOT_PROTOCOL_OWNER',
        statusCode: 403,
      });
    });

    it('throws FORBIDDEN_NOT_YOUR_PROTOCOL when user is not assignee', async () => {
      prisma.trainingProtocol.findUnique.mockResolvedValue({
        id: 'p1',
        trainerId: 't1',
        assigneeId: 'other-user',
        deletedAt: null,
      });

      await expect(
        getProtocolById('u1', 'p1', 'assignee'),
      ).rejects.toMatchObject({
        code: 'FORBIDDEN_NOT_YOUR_PROTOCOL',
        statusCode: 403,
      });
    });

    it('returns protocol with assignee when trainer owns it', async () => {
      const protocol = {
        id: 'p1',
        trainerId: 't1',
        assigneeId: 'assignee-1',
        assignee: {
          id: 'assignee-1',
          firstName: 'John',
          lastName: 'Doe',
          avatarUrl: null,
        },
        deletedAt: null,
      };
      prisma.trainingProtocol.findUnique.mockResolvedValue(protocol);
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });

      const result = await getProtocolById('trainer-user-id', 'p1', 'trainer');

      expect(result).toEqual(protocol);
      expect(result.assignee).toMatchObject({
        id: 'assignee-1',
        firstName: 'John',
        lastName: 'Doe',
      });
    });
  });

  describe('updateProtocol', () => {
    it('throws TRAINER_PROFILE_MISSING when trainer does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue(null);

      await expect(
        updateProtocol('u1', 'p1', { name: 'New Name' }),
      ).rejects.toMatchObject({
        code: 'TRAINER_PROFILE_MISSING',
        statusCode: 404,
      });
    });

    it('throws FORBIDDEN_NOT_PROTOCOL_OWNER when trainer does not own protocol', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingProtocol.findUnique.mockResolvedValue({
        id: 'p1',
        trainerId: 'other-trainer',
        deletedAt: null,
      });

      await expect(
        updateProtocol('u1', 'p1', { name: 'New Name' }),
      ).rejects.toMatchObject({
        code: 'FORBIDDEN_NOT_PROTOCOL_OWNER',
        statusCode: 403,
      });
    });

    it('updates protocol and returns with assignee', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingProtocol.findUnique.mockResolvedValue({
        id: 'p1',
        trainerId: 't1',
        deletedAt: null,
      });
      const updated = {
        id: 'p1',
        name: 'Updated Name',
        assignee: {
          id: 'assignee-1',
          firstName: 'John',
          lastName: 'Doe',
          avatarUrl: null,
        },
      };
      prisma.trainingProtocol.update.mockResolvedValue(updated);

      const result = await updateProtocol('u1', 'p1', { name: 'Updated Name' });

      expect(result).toEqual(updated);
      expect(result.assignee).toMatchObject({
        id: 'assignee-1',
        firstName: 'John',
        lastName: 'Doe',
      });
    });
  });

  describe('deleteProtocol', () => {
    it('throws FORBIDDEN_NOT_PROTOCOL_OWNER when trainer does not own protocol', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingProtocol.findUnique.mockResolvedValue({
        id: 'p1',
        trainerId: 'other-trainer',
        deletedAt: null,
      });

      await expect(deleteProtocol('u1', 'p1')).rejects.toMatchObject({
        code: 'FORBIDDEN_NOT_PROTOCOL_OWNER',
        statusCode: 403,
      });
    });

    it('soft deletes protocol', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingProtocol.findUnique.mockResolvedValue({
        id: 'p1',
        trainerId: 't1',
        deletedAt: null,
      });
      const deleted = { id: 'p1', deletedAt: new Date() };
      prisma.trainingProtocol.update.mockResolvedValue(deleted);

      const result = await deleteProtocol('u1', 'p1');

      expect(result).toEqual(deleted);
      expect(prisma.trainingProtocol.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'p1' },
          data: expect.objectContaining({
            deletedAt: expect.any(Date),
          }),
        }),
      );
    });
  });

  describe('importFromTemplate', () => {
    it('throws TRAINER_PROFILE_MISSING when trainer does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue(null);

      await expect(
        importFromTemplate('u1', 'tmpl-1', 'assignee-1'),
      ).rejects.toMatchObject({
        code: 'TRAINER_PROFILE_MISSING',
        statusCode: 404,
      });
    });

    it('throws TEMPLATE_NOT_FOUND when template does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingProtocolTemplate.findUnique.mockResolvedValue(null);

      await expect(
        importFromTemplate('u1', 'tmpl-1', 'assignee-1'),
      ).rejects.toMatchObject({
        code: 'TEMPLATE_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws ASSIGNEE_NOT_FOUND when assignee user does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingProtocolTemplate.findUnique.mockResolvedValue({
        id: 'tmpl-1',
        trainerId: 't1',
        deletedAt: null,
      });
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        importFromTemplate('u1', 'tmpl-1', 'nonexistent'),
      ).rejects.toMatchObject({
        code: 'ASSIGNEE_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws ASSIGNEE_NOT_FOUND when assignee is soft-deleted', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingProtocolTemplate.findUnique.mockResolvedValue({
        id: 'tmpl-1',
        trainerId: 't1',
        deletedAt: null,
      });
      prisma.user.findUnique.mockResolvedValue({ id: 'assignee-1', deletedAt: new Date() });

      await expect(
        importFromTemplate('u1', 'tmpl-1', 'assignee-1'),
      ).rejects.toMatchObject({
        code: 'ASSIGNEE_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('creates protocol from template with assignee', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingProtocolTemplate.findUnique.mockResolvedValue({
        id: 'tmpl-1',
        trainerId: 't1',
        name: 'Template A',
        deletedAt: null,
      });
      prisma.user.findUnique.mockResolvedValue({ id: 'assignee-1' });
      const created = {
        id: 'p1',
        assigneeId: 'assignee-1',
        assignee: {
          id: 'assignee-1',
          firstName: 'Jane',
          lastName: 'Smith',
          avatarUrl: null,
        },
      };
      prisma.trainingProtocol.create.mockResolvedValue(created);

      const result = await importFromTemplate('u1', 'tmpl-1', 'assignee-1');

      expect(result).toEqual(created);
      expect(result.assignee).toMatchObject({
        id: 'assignee-1',
        firstName: 'Jane',
        lastName: 'Smith',
      });
    });
  });
});
