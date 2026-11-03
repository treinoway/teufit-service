import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock platform-plan-service — gating is tested separately
vi.mock('../../src/services/platform-plan-service.js', () => ({
  assertStudentActiveOnPlan: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/db.js', () => ({
  prisma: {
    trainer: { findUnique: vi.fn(), updateMany: vi.fn() },
    user: { findUnique: vi.fn() },
    trainingProtocol: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    trainingProtocolTemplate: { findUnique: vi.fn() },
    advancedTechnique: { findMany: vi.fn() },
    training: { create: vi.fn() },
    exercise: { create: vi.fn() },
    $transaction: vi.fn(),
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
import { assertStudentActiveOnPlan } from '../../src/services/platform-plan-service.js';

describe('training-protocol-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-apply platform-plan-service mocks after mockReset (mockReset: true in vitest config).
    assertStudentActiveOnPlan.mockResolvedValue(undefined);
    prisma.$transaction.mockImplementation(async (fn) => fn(prisma));
    prisma.trainer.updateMany.mockResolvedValue({ count: 0 });
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

    it('throws INVALID_GENDER_ORDINATION when genderOrdination is invalid', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.user.findUnique.mockResolvedValue({ id: 'assignee-1' });

      await expect(
        createProtocol('u1', {
          assigneeId: 'assignee-1',
          name: 'Protocol A',
          startDate: '2025-01-01',
          genderOrdination: 'invalid-gender',
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_GENDER_ORDINATION',
      });

      expect(prisma.trainingProtocol.create).not.toHaveBeenCalled();
    });

    it('throws INVALID_TRAINING_LEVEL when trainingLevel is invalid', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.user.findUnique.mockResolvedValue({ id: 'assignee-1' });

      await expect(
        createProtocol('u1', {
          assigneeId: 'assignee-1',
          name: 'Protocol A',
          startDate: '2025-01-01',
          trainingLevel: 'invalid-level',
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_TRAINING_LEVEL',
      });

      expect(prisma.trainingProtocol.create).not.toHaveBeenCalled();
    });

    it('throws INVALID_PROTOCOL_TYPE when type is invalid', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.user.findUnique.mockResolvedValue({ id: 'assignee-1' });

      await expect(
        createProtocol('u1', {
          assigneeId: 'assignee-1',
          name: 'Protocol A',
          startDate: '2025-01-01',
          type: 'invalid-type',
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_PROTOCOL_TYPE',
      });

      expect(prisma.trainingProtocol.create).not.toHaveBeenCalled();
    });

    it('creates protocol with type included', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.user.findUnique.mockResolvedValue({ id: 'assignee-1' });
      const created = {
        id: 'p1',
        trainerId: 't1',
        assigneeId: 'assignee-1',
        name: 'Protocol A',
        status: 'active',
        type: 'strength',
        startDate: new Date('2025-01-01'),
        assignee: { id: 'assignee-1', firstName: 'John', lastName: 'Doe', avatarUrl: null },
      };
      prisma.trainingProtocol.create.mockResolvedValue(created);

      const result = await createProtocol('u1', {
        assigneeId: 'assignee-1',
        name: 'Protocol A',
        startDate: '2025-01-01',
        type: 'strength',
      });

      expect(result.type).toBe('strength');
      expect(prisma.trainingProtocol.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ type: 'strength' }),
        }),
      );
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

    it('throws INVALID_PROTOCOL_TYPE when type is invalid', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingProtocol.findUnique.mockResolvedValue({
        id: 'p1',
        trainerId: 't1',
        deletedAt: null,
      });

      await expect(
        updateProtocol('u1', 'p1', { type: 'invalid-type' }),
      ).rejects.toMatchObject({ code: 'INVALID_PROTOCOL_TYPE' });

      expect(prisma.trainingProtocol.update).not.toHaveBeenCalled();
    });

    it('updates protocol type', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingProtocol.findUnique.mockResolvedValue({
        id: 'p1',
        trainerId: 't1',
        deletedAt: null,
      });
      const updated = { id: 'p1', type: 'cardio', assignee: null };
      prisma.trainingProtocol.update.mockResolvedValue(updated);

      const result = await updateProtocol('u1', 'p1', { type: 'cardio' });

      expect(result.type).toBe('cardio');
      expect(prisma.trainingProtocol.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ type: 'cardio' }),
        }),
      );
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

    it('throws PROTOCOL_STATUS_NOT_DELETABLE when protocol status is active', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingProtocol.findUnique.mockResolvedValue({
        id: 'p1',
        trainerId: 't1',
        status: 'active',
        deletedAt: null,
      });

      await expect(deleteProtocol('u1', 'p1')).rejects.toMatchObject({
        code: 'PROTOCOL_STATUS_NOT_DELETABLE',
        statusCode: 409,
      });
    });

    it('soft deletes protocol when status is completed', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingProtocol.findUnique.mockResolvedValue({
        id: 'p1',
        trainerId: 't1',
        status: 'completed',
        deletedAt: null,
      });
      const deleted = { id: 'p1', status: 'completed', deletedAt: new Date() };
      prisma.trainingProtocol.update.mockResolvedValue(deleted);

      await expect(deleteProtocol('u1', 'p1')).resolves.toEqual(deleted);
    });

    it('soft deletes protocol when status is archived', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingProtocol.findUnique.mockResolvedValue({
        id: 'p1',
        trainerId: 't1',
        status: 'archived',
        deletedAt: null,
      });
      const deleted = { id: 'p1', status: 'archived', deletedAt: new Date() };
      prisma.trainingProtocol.update.mockResolvedValue(deleted);

      await expect(deleteProtocol('u1', 'p1')).resolves.toEqual(deleted);
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

    it('creates protocol from template with assignee (no trainings)', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingProtocolTemplate.findUnique.mockResolvedValue({
        id: 'tmpl-1',
        trainerId: 't1',
        name: 'Template A',
        deletedAt: null,
        trainings: [],
      });
      prisma.user.findUnique.mockResolvedValue({ id: 'assignee-1' });
      const createdProtocol = {
        id: 'p1',
        assigneeId: 'assignee-1',
        trainings: [],
        assignee: { id: 'assignee-1', firstName: 'Jane', lastName: 'Smith', avatarUrl: null },
      };
      prisma.trainingProtocol.create.mockResolvedValue(createdProtocol);

      const result = await importFromTemplate('u1', 'tmpl-1', 'assignee-1');

      expect(result.assignee).toMatchObject({ id: 'assignee-1', firstName: 'Jane' });
      expect(result.trainings).toHaveLength(0);
      // The new implementation uses a single nested create — training.create is never called
      expect(prisma.training.create).not.toHaveBeenCalled();
    });

    it('creates trainings with weekDay from template trainings', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingProtocolTemplate.findUnique.mockResolvedValue({
        id: 'tmpl-1',
        trainerId: 't1',
        name: 'Template A',
        deletedAt: null,
        trainings: [
          {
            id: 'pt-1',
            weekDay: 'monday',
            order: 0,
            trainingTemplate: {
              id: 'tt-1',
              name: 'Bench Press',
              description: null,
              category: 'strength',
              bodySegment: 'upper',
              trainingTemplateExerciseTemplates: [],
            },
          },
        ],
      });
      prisma.user.findUnique.mockResolvedValue({ id: 'assignee-1' });
      const createdProtocol = {
        id: 'p1',
        assigneeId: 'assignee-1',
        trainings: [{ id: 'tr-1', name: 'Bench Press', weekDay: 'monday' }],
        assignee: { id: 'assignee-1', firstName: 'Jane', lastName: 'Smith', avatarUrl: null },
      };
      prisma.trainingProtocol.create.mockResolvedValue(createdProtocol);

      const result = await importFromTemplate('u1', 'tmpl-1', 'assignee-1');

      // The new implementation passes trainings as a nested create inside trainingProtocol.create
      expect(prisma.trainingProtocol.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            trainings: {
              create: expect.arrayContaining([
                expect.objectContaining({
                  trainingTemplateId: 'tt-1',
                  name: 'Bench Press',
                  category: 'strength',
                  weekDay: 'monday',
                  order: 0,
                }),
              ]),
            },
          }),
        }),
      );
      expect(result.trainings).toHaveLength(1);
    });

    describe('advanced technique links', () => {
      const makeJunction = (id, order, links) => ({
        id,
        exerciseTemplateId: `et-${id}`,
        order,
        name: `Exercise ${id}`,
        type: 'strength',
        videoUrl: null,
        sets: 3,
        repetitions: 10,
        duration: null,
        hasLoad: false,
        suggestedLoad: null,
        notes: null,
        exerciseTemplate: { id: `et-${id}`, name: `Exercise ${id}`, type: 'strength' },
        advancedTechniqueLinks: links,
      });

      const arrangeTemplate = (junctions) => {
        prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
        prisma.trainingProtocolTemplate.findUnique.mockResolvedValue({
          id: 'tmpl-1',
          trainerId: 't1',
          name: 'Template A',
          deletedAt: null,
          trainings: [
            {
              id: 'pt-1',
              weekDay: 'monday',
              order: 0,
              trainingTemplate: {
                id: 'tt-1',
                name: 'Training',
                description: null,
                category: 'strength',
                bodySegment: 'upper',
                trainingTemplateExerciseTemplates: junctions,
              },
            },
          ],
        });
        prisma.user.findUnique.mockResolvedValue({ id: 'assignee-1' });
        prisma.trainingProtocol.create.mockResolvedValue({ id: 'p1', trainings: [], assignee: {} });
      };

      const createdExercises = () =>
        prisma.trainingProtocol.create.mock.calls[0][0].data.trainings.create[0].exercises.create;

      it('loads the junction technique links with the template', async () => {
        arrangeTemplate([]);

        await importFromTemplate('u1', 'tmpl-1', 'assignee-1');

        const junctionInclude =
          prisma.trainingProtocolTemplate.findUnique.mock.calls[0][0].include.trainings.include.trainingTemplate
            .include.trainingTemplateExerciseTemplates.include;
        expect(junctionInclude.advancedTechniqueLinks).toBe(true);
      });

      it('copies the links as an ordered snapshot onto each new exercise', async () => {
        arrangeTemplate([
          makeJunction('jt-1', 0, [
            { advancedTechniqueId: 'tech-b', order: 1 },
            { advancedTechniqueId: 'tech-a', order: 0 },
          ]),
        ]);
        prisma.advancedTechnique.findMany.mockResolvedValue([{ id: 'tech-a' }, { id: 'tech-b' }]);

        await importFromTemplate('u1', 'tmpl-1', 'assignee-1');

        expect(createdExercises()[0].advancedTechniqueLinks).toEqual({
          create: [
            { advancedTechniqueId: 'tech-a', order: 0 },
            { advancedTechniqueId: 'tech-b', order: 1 },
          ],
        });
      });

      it('drops deleted or foreign-private techniques and re-indexes the order', async () => {
        arrangeTemplate([
          makeJunction('jt-1', 0, [
            { advancedTechniqueId: 'tech-gone', order: 0 },
            { advancedTechniqueId: 'tech-ok', order: 1 },
          ]),
        ]);
        prisma.advancedTechnique.findMany.mockResolvedValue([{ id: 'tech-ok' }]);

        await importFromTemplate('u1', 'tmpl-1', 'assignee-1');

        expect(createdExercises()[0].advancedTechniqueLinks).toEqual({
          create: [{ advancedTechniqueId: 'tech-ok', order: 0 }],
        });
      });

      it('omits advancedTechniqueLinks when no link survives', async () => {
        arrangeTemplate([makeJunction('jt-1', 0, [{ advancedTechniqueId: 'tech-gone', order: 0 }])]);
        prisma.advancedTechnique.findMany.mockResolvedValue([]);

        await importFromTemplate('u1', 'tmpl-1', 'assignee-1');

        expect(createdExercises()[0]).not.toHaveProperty('advancedTechniqueLinks');
      });

      it('validates visibility of all linked techniques in a single query', async () => {
        arrangeTemplate([
          makeJunction('jt-1', 0, [{ advancedTechniqueId: 'tech-a', order: 0 }]),
          makeJunction('jt-2', 1, [
            { advancedTechniqueId: 'tech-a', order: 0 },
            { advancedTechniqueId: 'tech-b', order: 1 },
          ]),
        ]);
        prisma.advancedTechnique.findMany.mockResolvedValue([{ id: 'tech-a' }, { id: 'tech-b' }]);

        await importFromTemplate('u1', 'tmpl-1', 'assignee-1');

        expect(prisma.advancedTechnique.findMany).toHaveBeenCalledTimes(1);
        expect([...prisma.advancedTechnique.findMany.mock.calls[0][0].where.id.in].sort()).toEqual([
          'tech-a',
          'tech-b',
        ]);
        expect(createdExercises()[1].advancedTechniqueLinks.create).toHaveLength(2);
      });
    });

    it('creates exercises from training template exercise templates', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingProtocolTemplate.findUnique.mockResolvedValue({
        id: 'tmpl-1',
        trainerId: 't1',
        name: 'Template A',
        deletedAt: null,
        trainings: [
          {
            id: 'pt-1',
            weekDay: 'monday',
            order: 0,
            trainingTemplate: {
              id: 'tt-1',
              name: 'Bench Press',
              description: null,
              category: 'strength',
              bodySegment: 'upper',
              trainingTemplateExerciseTemplates: [
                {
                  id: 'jt-1',
                  exerciseTemplateId: 'et-1',
                  order: 0,
                  name: 'Supino',
                  type: 'strength',
                  videoUrl: null,
                  sets: 3,
                  repetitions: 10,
                  duration: null,
                  hasLoad: true,
                  suggestedLoad: 60,
                  restInterval: 90,
                  notes: null,
                  exerciseTemplate: { id: 'et-1', name: 'Supino', type: 'strength' },
                },
                {
                  id: 'jt-2',
                  exerciseTemplateId: 'et-2',
                  order: 1,
                  name: 'Crucifixo',
                  type: 'strength',
                  videoUrl: 'https://example.com/video',
                  sets: 3,
                  repetitions: 12,
                  duration: null,
                  hasLoad: false,
                  suggestedLoad: null,
                  notes: null,
                  exerciseTemplate: { id: 'et-2', name: 'Crucifixo', type: 'strength' },
                },
              ],
            },
          },
        ],
      });
      prisma.user.findUnique.mockResolvedValue({ id: 'assignee-1' });
      const createdProtocol = {
        id: 'p1',
        assigneeId: 'assignee-1',
        trainings: [{ id: 'tr-1', name: 'Bench Press', weekDay: 'monday' }],
        assignee: { id: 'assignee-1', firstName: 'Jane', lastName: 'Smith', avatarUrl: null },
      };
      prisma.trainingProtocol.create.mockResolvedValue(createdProtocol);

      await importFromTemplate('u1', 'tmpl-1', 'assignee-1');

      // The new implementation passes exercises as nested creates inside data.trainings.create
      // — exercise.create is never called independently
      expect(prisma.exercise.create).not.toHaveBeenCalled();

      const createCall = prisma.trainingProtocol.create.mock.calls[0][0];
      const exercisesCreate = createCall.data.trainings.create[0].exercises.create;

      expect(exercisesCreate).toHaveLength(2);
      expect(exercisesCreate[0]).toMatchObject({
        exerciseTemplateId: 'et-1',
        name: 'Supino',
        type: 'strength',
        videoUrl: null,
        order: 0,
        sets: 3,
        repetitions: 10,
        hasLoad: true,
        suggestedLoad: 60,
        restInterval: 90,
        prescriptionMode: 'reps',
      });
      expect(exercisesCreate[1]).toMatchObject({
        exerciseTemplateId: 'et-2',
        name: 'Crucifixo',
        type: 'strength',
        videoUrl: 'https://example.com/video',
        order: 1,
        hasLoad: false,
        suggestedLoad: null,
        prescriptionMode: 'reps',
      });
    });

    it('copies gifUrl from training template exercise rows into the nested exercise create data', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingProtocolTemplate.findUnique.mockResolvedValue({
        id: 'tmpl-1',
        trainerId: 't1',
        name: 'Template A',
        deletedAt: null,
        trainings: [
          {
            id: 'pt-1',
            weekDay: 'monday',
            order: 0,
            trainingTemplate: {
              id: 'tt-1',
              name: 'Bench Press',
              description: null,
              category: 'strength',
              bodySegment: 'upper',
              trainingTemplateExerciseTemplates: [
                {
                  id: 'jt-1',
                  exerciseTemplateId: 'et-1',
                  order: 0,
                  name: 'Supino',
                  type: 'strength',
                  videoUrl: null,
                  gifUrl: 'https://example.com/supino.gif',
                  sets: 3,
                  repetitions: 10,
                  duration: null,
                  hasLoad: true,
                  suggestedLoad: 60,
                  notes: null,
                  exerciseTemplate: { id: 'et-1', name: 'Supino', type: 'strength' },
                },
              ],
            },
          },
        ],
      });
      prisma.user.findUnique.mockResolvedValue({ id: 'assignee-1' });
      prisma.trainingProtocol.create.mockResolvedValue({
        id: 'p1',
        assigneeId: 'assignee-1',
        trainings: [],
        assignee: { id: 'assignee-1', firstName: 'Jane', lastName: 'Smith', avatarUrl: null },
      });

      await importFromTemplate('u1', 'tmpl-1', 'assignee-1');

      const createCall = prisma.trainingProtocol.create.mock.calls[0][0];
      const [exerciseCreate] = createCall.data.trainings.create[0].exercises.create;
      expect(exerciseCreate).toMatchObject({ gifUrl: 'https://example.com/supino.gif' });
    });

    it('copies videoFileKey from training template exercise rows into the nested exercise create data', async () => {
      const key = 'exercise-videos/t1/11111111-1111-4111-8111-111111111111.mp4';
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingProtocolTemplate.findUnique.mockResolvedValue({
        id: 'tmpl-1',
        trainerId: 't1',
        name: 'Template A',
        deletedAt: null,
        trainings: [
          {
            id: 'pt-1',
            weekDay: 'monday',
            order: 0,
            trainingTemplate: {
              id: 'tt-1',
              name: 'Bench Press',
              description: null,
              category: 'strength',
              bodySegment: 'upper',
              trainingTemplateExerciseTemplates: [
                {
                  id: 'jt-1',
                  exerciseTemplateId: 'et-1',
                  order: 0,
                  name: 'Supino',
                  type: 'strength',
                  videoUrl: null,
                  videoFileKey: key,
                  sets: 3,
                  repetitions: 10,
                  duration: null,
                  hasLoad: true,
                  suggestedLoad: 60,
                  notes: null,
                  exerciseTemplate: { id: 'et-1', name: 'Supino', type: 'strength' },
                },
              ],
            },
          },
        ],
      });
      prisma.user.findUnique.mockResolvedValue({ id: 'assignee-1' });
      prisma.trainingProtocol.create.mockResolvedValue({
        id: 'p1',
        assigneeId: 'assignee-1',
        trainings: [],
        assignee: { id: 'assignee-1', firstName: 'Jane', lastName: 'Smith', avatarUrl: null },
      });

      await importFromTemplate('u1', 'tmpl-1', 'assignee-1');

      const createCall = prisma.trainingProtocol.create.mock.calls[0][0];
      const [exerciseCreate] = createCall.data.trainings.create[0].exercises.create;
      expect(exerciseCreate).toMatchObject({ videoFileKey: key });
    });

    it('inherits genderOrdination and trainingLevel from template when not overridden', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingProtocolTemplate.findUnique.mockResolvedValue({
        id: 'tmpl-1',
        trainerId: 't1',
        name: 'Template A',
        genderOrdination: 'female',
        trainingLevel: 'intermediate',
        deletedAt: null,
        trainings: [],
      });
      prisma.user.findUnique.mockResolvedValue({ id: 'assignee-1' });
      const created = { id: 'p1', assigneeId: 'assignee-1' };
      prisma.trainingProtocol.create.mockResolvedValue(created);
      prisma.trainingProtocol.findUnique.mockResolvedValue({ ...created, trainings: [], assignee: null });

      await importFromTemplate('u1', 'tmpl-1', 'assignee-1');

      expect(prisma.trainingProtocol.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            genderOrdination: 'female',
            trainingLevel: 'intermediate',
          }),
        }),
      );
    });

    it('overrides genderOrdination and trainingLevel from template when provided in data', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingProtocolTemplate.findUnique.mockResolvedValue({
        id: 'tmpl-1',
        trainerId: 't1',
        name: 'Template A',
        genderOrdination: 'female',
        trainingLevel: 'intermediate',
        deletedAt: null,
        trainings: [],
      });
      prisma.user.findUnique.mockResolvedValue({ id: 'assignee-1' });
      const created = { id: 'p1', assigneeId: 'assignee-1' };
      prisma.trainingProtocol.create.mockResolvedValue(created);
      prisma.trainingProtocol.findUnique.mockResolvedValue({ ...created, trainings: [], assignee: null });

      await importFromTemplate('u1', 'tmpl-1', 'assignee-1', {
        genderOrdination: 'male',
        trainingLevel: 'athlete',
      });

      expect(prisma.trainingProtocol.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            genderOrdination: 'male',
            trainingLevel: 'athlete',
          }),
        }),
      );
    });

    it('inherits type from template when not provided in data', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingProtocolTemplate.findUnique.mockResolvedValue({
        id: 'tmpl-1',
        trainerId: 't1',
        name: 'Template A',
        type: 'cardio',
        deletedAt: null,
        trainings: [],
      });
      prisma.user.findUnique.mockResolvedValue({ id: 'assignee-1' });
      const created = { id: 'p1', assigneeId: 'assignee-1' };
      prisma.trainingProtocol.create.mockResolvedValue(created);
      prisma.trainingProtocol.findUnique.mockResolvedValue({ ...created, trainings: [], assignee: null });

      await importFromTemplate('u1', 'tmpl-1', 'assignee-1');

      expect(prisma.trainingProtocol.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ type: 'cardio' }),
        }),
      );
    });

    it('overrides type from template when explicitly provided in data', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingProtocolTemplate.findUnique.mockResolvedValue({
        id: 'tmpl-1',
        trainerId: 't1',
        name: 'Template A',
        type: 'cardio',
        deletedAt: null,
        trainings: [],
      });
      prisma.user.findUnique.mockResolvedValue({ id: 'assignee-1' });
      const created = { id: 'p1', assigneeId: 'assignee-1' };
      prisma.trainingProtocol.create.mockResolvedValue(created);
      prisma.trainingProtocol.findUnique.mockResolvedValue({ ...created, trainings: [], assignee: null });

      await importFromTemplate('u1', 'tmpl-1', 'assignee-1', { type: 'strength' });

      expect(prisma.trainingProtocol.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ type: 'strength' }),
        }),
      );
    });

    it('copies intensity from junction row into exercise create data', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingProtocolTemplate.findUnique.mockResolvedValue({
        id: 'tmpl-1',
        trainerId: 't1',
        name: 'Template A',
        deletedAt: null,
        trainings: [
          {
            id: 'pt-1',
            weekDay: null,
            order: 0,
            trainingTemplate: {
              id: 'tt-1',
              name: 'Cardio Day',
              description: null,
              category: 'cardio',
              bodySegment: null,
              trainingTemplateExerciseTemplates: [
                {
                  exerciseTemplateId: 'et-1',
                  order: 0,
                  name: 'Corrida',
                  type: 'cardio',
                  videoUrl: null,
                  sets: 3,
                  repetitions: null,
                  duration: 600,
                  prescriptionMode: 'duration',
                  hasLoad: false,
                  suggestedLoad: null,
                  restInterval: null,
                  notes: null,
                  intensity: 'vigorous',
                },
              ],
            },
          },
        ],
      });
      prisma.user.findUnique.mockResolvedValue({ id: 'assignee-1' });
      prisma.trainingProtocol.create.mockResolvedValue({
        id: 'p1',
        assigneeId: 'assignee-1',
        trainings: [],
        assignee: { id: 'assignee-1', firstName: 'Jane', lastName: 'Smith', avatarUrl: null },
      });

      await importFromTemplate('u1', 'tmpl-1', 'assignee-1');

      const createCall = prisma.trainingProtocol.create.mock.calls[0][0];
      const exercisesCreate = createCall.data.trainings.create[0].exercises.create;
      expect(exercisesCreate[0].intensity).toBe('vigorous');
    });

    it('sets intensity to null when junction row has no intensity', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingProtocolTemplate.findUnique.mockResolvedValue({
        id: 'tmpl-1',
        trainerId: 't1',
        name: 'Template A',
        deletedAt: null,
        trainings: [
          {
            id: 'pt-1',
            weekDay: null,
            order: 0,
            trainingTemplate: {
              id: 'tt-1',
              name: 'Força',
              description: null,
              category: 'strength',
              bodySegment: null,
              trainingTemplateExerciseTemplates: [
                {
                  exerciseTemplateId: 'et-1',
                  order: 0,
                  name: 'Squat',
                  type: 'strength',
                  videoUrl: null,
                  sets: 4,
                  repetitions: 10,
                  duration: null,
                  prescriptionMode: 'reps',
                  hasLoad: true,
                  suggestedLoad: 80,
                  restInterval: 90,
                  notes: null,
                  intensity: null,
                },
              ],
            },
          },
        ],
      });
      prisma.user.findUnique.mockResolvedValue({ id: 'assignee-1' });
      prisma.trainingProtocol.create.mockResolvedValue({
        id: 'p1',
        assigneeId: 'assignee-1',
        trainings: [],
        assignee: { id: 'assignee-1', firstName: 'Jane', lastName: 'Smith', avatarUrl: null },
      });

      await importFromTemplate('u1', 'tmpl-1', 'assignee-1');

      const createCall = prisma.trainingProtocol.create.mock.calls[0][0];
      const exercisesCreate = createCall.data.trainings.create[0].exercises.create;
      expect(exercisesCreate[0].intensity).toBeNull();
    });

    it('computes estimatedDurationSeconds > 0 for training with exercises', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingProtocolTemplate.findUnique.mockResolvedValue({
        id: 'tmpl-1',
        trainerId: 't1',
        name: 'Template A',
        deletedAt: null,
        trainings: [
          {
            id: 'pt-1',
            weekDay: 'monday',
            order: 0,
            trainingTemplate: {
              id: 'tt-1',
              name: 'Força',
              description: null,
              category: 'strength',
              bodySegment: 'upper',
              trainingTemplateExerciseTemplates: [
                {
                  exerciseTemplateId: 'et-1',
                  order: 0,
                  name: 'Bench Press',
                  type: 'strength',
                  videoUrl: null,
                  sets: 4,
                  repetitions: 10,
                  duration: null,
                  prescriptionMode: 'reps',
                  hasLoad: true,
                  suggestedLoad: 60,
                  restInterval: 90,
                  notes: null,
                  intensity: null,
                },
              ],
            },
          },
        ],
      });
      prisma.user.findUnique.mockResolvedValue({ id: 'assignee-1' });
      prisma.trainingProtocol.create.mockResolvedValue({
        id: 'p1',
        assigneeId: 'assignee-1',
        trainings: [],
        assignee: { id: 'assignee-1', firstName: 'Jane', lastName: 'Smith', avatarUrl: null },
      });

      await importFromTemplate('u1', 'tmpl-1', 'assignee-1');

      const createCall = prisma.trainingProtocol.create.mock.calls[0][0];
      const trainingData = createCall.data.trainings.create[0];
      expect(trainingData.estimatedDurationSeconds).toBeGreaterThan(0);
    });

    it('sets estimatedDurationSeconds to 0 for training with no exercises', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingProtocolTemplate.findUnique.mockResolvedValue({
        id: 'tmpl-1',
        trainerId: 't1',
        name: 'Template A',
        deletedAt: null,
        trainings: [
          {
            id: 'pt-1',
            weekDay: null,
            order: 0,
            trainingTemplate: {
              id: 'tt-1',
              name: 'Descanso',
              description: null,
              category: 'rest',
              bodySegment: null,
              trainingTemplateExerciseTemplates: [],
            },
          },
        ],
      });
      prisma.user.findUnique.mockResolvedValue({ id: 'assignee-1' });
      prisma.trainingProtocol.create.mockResolvedValue({
        id: 'p1',
        assigneeId: 'assignee-1',
        trainings: [],
        assignee: { id: 'assignee-1', firstName: 'Jane', lastName: 'Smith', avatarUrl: null },
      });

      await importFromTemplate('u1', 'tmpl-1', 'assignee-1');

      const createCall = prisma.trainingProtocol.create.mock.calls[0][0];
      const trainingData = createCall.data.trainings.create[0];
      expect(trainingData.estimatedDurationSeconds).toBe(0);
    });
  });
});
