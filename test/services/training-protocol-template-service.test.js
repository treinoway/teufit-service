import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    trainer: { findUnique: vi.fn() },
    trainingProtocolTemplate: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    trainingTemplate: { findMany: vi.fn() },
    protocolTemplateTraining: {
      createMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../src/services/trainer-onboarding-service.js', () => ({
  maybeMarkFirstProtocolCreated: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from '../../src/db.js';
import { maybeMarkFirstProtocolCreated } from '../../src/services/trainer-onboarding-service.js';
import {
  createProtocolTemplate,
  getProtocolTemplatesByTrainer,
  batchDeleteProtocolTemplates,
  getProtocolTemplateById,
  updateProtocolTemplate,
  deleteProtocolTemplate,
} from '../../src/services/training-protocol-template-service.js';

const baseTemplate = {
  id: 'tmpl-1',
  trainerId: 'trainer-1',
  name: 'Test Template',
  description: null,
  defaultDurationWeeks: null,
  genderOrdination: null,
  trainingLevel: null,
  type: null,
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: null,
  trainings: [],
  trainingsCount: 0,
};

describe('training-protocol-template-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$transaction.mockImplementation(async (fn) => fn(prisma));
    maybeMarkFirstProtocolCreated.mockResolvedValue(undefined);
  });

  // ==================== createProtocolTemplate ====================

  describe('createProtocolTemplate', () => {
    it('throws TRAINER_PROFILE_MISSING when trainer does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue(null);

      await expect(createProtocolTemplate('u1', { name: 'T' })).rejects.toMatchObject({
        code: 'TRAINER_PROFILE_MISSING',
        statusCode: 404,
      });
      expect(prisma.trainingProtocolTemplate.create).not.toHaveBeenCalled();
    });

    it('throws INVALID_GENDER_ORDINATION when genderOrdination is invalid', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });

      await expect(
        createProtocolTemplate('u1', { name: 'T', genderOrdination: 'alien' }),
      ).rejects.toMatchObject({ code: 'INVALID_GENDER_ORDINATION' });
    });

    it('throws INVALID_TRAINING_LEVEL when trainingLevel is invalid', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });

      await expect(
        createProtocolTemplate('u1', { name: 'T', trainingLevel: 'expert' }),
      ).rejects.toMatchObject({ code: 'INVALID_TRAINING_LEVEL' });
    });

    it('throws INVALID_PROTOCOL_TYPE when type is invalid', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });

      await expect(
        createProtocolTemplate('u1', { name: 'T', type: 'yoga' }),
      ).rejects.toMatchObject({ code: 'INVALID_PROTOCOL_TYPE' });

      expect(prisma.trainingProtocolTemplate.create).not.toHaveBeenCalled();
    });

    it('creates template with type', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainingProtocolTemplate.create.mockResolvedValue({ id: 'tmpl-1' });
      prisma.trainingProtocolTemplate.findUnique.mockResolvedValue({ ...baseTemplate, type: 'mobility' });

      const result = await createProtocolTemplate('u1', { name: 'Test Template', type: 'mobility' });

      expect(result.type).toBe('mobility');
      expect(prisma.trainingProtocolTemplate.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ type: 'mobility' }),
        }),
      );
    });

    it('creates template without trainings', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainingProtocolTemplate.create.mockResolvedValue({ id: 'tmpl-1' });
      prisma.trainingProtocolTemplate.findUnique.mockResolvedValue(baseTemplate);

      const result = await createProtocolTemplate('u1', { name: 'Test Template' });

      expect(result.trainingsCount).toBe(0);
      expect(prisma.trainingProtocolTemplate.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            trainerId: 'trainer-1',
            name: 'Test Template',
          }),
        }),
      );
      expect(prisma.protocolTemplateTraining.createMany).not.toHaveBeenCalled();
    });

    it('calls maybeMarkFirstProtocolCreated with the trainer id after successful creation', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainingProtocolTemplate.create.mockResolvedValue({ id: 'tmpl-1' });
      prisma.trainingProtocolTemplate.findUnique.mockResolvedValue(baseTemplate);

      await createProtocolTemplate('u1', { name: 'Test Template' });

      expect(maybeMarkFirstProtocolCreated).toHaveBeenCalledOnce();
      expect(maybeMarkFirstProtocolCreated).toHaveBeenCalledWith({ trainerId: 'trainer-1' });
    });

    it('does not call maybeMarkFirstProtocolCreated when trainer is not found', async () => {
      prisma.trainer.findUnique.mockResolvedValue(null);

      await expect(createProtocolTemplate('u1', { name: 'T' })).rejects.toMatchObject({
        code: 'TRAINER_PROFILE_MISSING',
      });

      expect(maybeMarkFirstProtocolCreated).not.toHaveBeenCalled();
    });

    it('throws TRAINING_TEMPLATE_NOT_FOUND when a training template in trainings does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainingTemplate.findMany.mockResolvedValue([]);

      await expect(
        createProtocolTemplate('u1', {
          name: 'T',
          trainings: [{ trainingTemplateId: 'tt-nonexistent', weekDay: 'monday', order: 0 }],
        }),
      ).rejects.toMatchObject({ code: 'TRAINING_TEMPLATE_NOT_FOUND', statusCode: 404 });
    });

    it('throws FORBIDDEN_TRAINING_TEMPLATE_ACCESS when training template belongs to another trainer and is not public', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainingTemplate.findMany.mockResolvedValue([
        { id: 'tt-1', trainerId: 'other-trainer', isPublic: false },
      ]);

      await expect(
        createProtocolTemplate('u1', {
          name: 'T',
          trainings: [{ trainingTemplateId: 'tt-1', weekDay: 'monday', order: 0 }],
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN_TRAINING_TEMPLATE_ACCESS', statusCode: 403 });
    });

    it('allows public training templates from other trainers', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainingTemplate.findMany.mockResolvedValue([
        { id: 'tt-1', trainerId: 'other-trainer', isPublic: true },
      ]);
      prisma.trainingProtocolTemplate.create.mockResolvedValue({ id: 'tmpl-1' });
      const resultTemplate = { ...baseTemplate, trainings: [{ id: 'pt-1', weekDay: 'monday' }] };
      prisma.trainingProtocolTemplate.findUnique.mockResolvedValue(resultTemplate);

      const result = await createProtocolTemplate('u1', {
        name: 'T',
        trainings: [{ trainingTemplateId: 'tt-1', weekDay: 'monday', order: 0 }],
      });

      expect(prisma.protocolTemplateTraining.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.arrayContaining([
            expect.objectContaining({ trainingTemplateId: 'tt-1', weekDay: 'monday' }),
          ]),
        }),
      );
      expect(result.trainings).toHaveLength(1);
    });

    it('creates protocol template trainings when trainings are provided', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainingTemplate.findMany.mockResolvedValue([
        { id: 'tt-1', trainerId: 'trainer-1', isPublic: false },
      ]);
      prisma.trainingProtocolTemplate.create.mockResolvedValue({ id: 'tmpl-1' });
      const resultTemplate = {
        ...baseTemplate,
        trainings: [{ id: 'pt-1', weekDay: 'monday', order: 0, trainingTemplate: { id: 'tt-1', name: 'Bench Press', category: 'strength', bodySegment: 'upper' } }],
      };
      prisma.trainingProtocolTemplate.findUnique.mockResolvedValue(resultTemplate);

      await createProtocolTemplate('u1', {
        name: 'T',
        trainings: [{ trainingTemplateId: 'tt-1', weekDay: 'monday', order: 0 }],
      });

      expect(prisma.protocolTemplateTraining.createMany).toHaveBeenCalledWith({
        data: [{ protocolTemplateId: 'tmpl-1', trainingTemplateId: 'tt-1', weekDay: 'monday', order: 0 }],
      });
    });

    it('allows trainings without weekDay (nullable)', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainingTemplate.findMany.mockResolvedValue([
        { id: 'tt-1', trainerId: 'trainer-1', isPublic: false },
      ]);
      prisma.trainingProtocolTemplate.create.mockResolvedValue({ id: 'tmpl-1' });
      prisma.trainingProtocolTemplate.findUnique.mockResolvedValue({
        ...baseTemplate,
        trainings: [{ id: 'pt-1', weekDay: null, order: 0 }],
      });

      await createProtocolTemplate('u1', {
        name: 'T',
        trainings: [{ trainingTemplateId: 'tt-1', order: 0 }],
      });

      expect(prisma.protocolTemplateTraining.createMany).toHaveBeenCalledWith({
        data: [{ protocolTemplateId: 'tmpl-1', trainingTemplateId: 'tt-1', weekDay: null, order: 0 }],
      });
    });
  });

  // ==================== getProtocolTemplatesByTrainer ====================

  describe('getProtocolTemplatesByTrainer', () => {
    it('throws TRAINER_PROFILE_MISSING when trainer does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue(null);

      await expect(getProtocolTemplatesByTrainer('u1')).rejects.toMatchObject({
        code: 'TRAINER_PROFILE_MISSING',
        statusCode: 404,
      });
    });

    it('returns paginated result with trainingsCount', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainingProtocolTemplate.findMany.mockResolvedValue([
        { ...baseTemplate, _count: { trainings: 3 } },
      ]);
      prisma.trainingProtocolTemplate.count.mockResolvedValue(1);

      const result = await getProtocolTemplatesByTrainer('u1');

      expect(result.data).toHaveLength(1);
      expect(result.data[0].trainingsCount).toBe(3);
      expect(result.data[0]._count).toBeUndefined();
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
    });

    it('returns empty data array when trainer has no templates', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainingProtocolTemplate.findMany.mockResolvedValue([]);
      prisma.trainingProtocolTemplate.count.mockResolvedValue(0);

      const result = await getProtocolTemplatesByTrainer('u1');

      expect(result.data).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('passes name ILIKE filter when filters.q is provided', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainingProtocolTemplate.findMany.mockResolvedValue([]);
      prisma.trainingProtocolTemplate.count.mockResolvedValue(0);

      await getProtocolTemplatesByTrainer('u1', { q: 'push' });

      const findManyCall = prisma.trainingProtocolTemplate.findMany.mock.calls[0][0];
      expect(findManyCall.where).toMatchObject({
        name: { contains: 'push', mode: 'insensitive' },
      });
      const countCall = prisma.trainingProtocolTemplate.count.mock.calls[0][0];
      expect(countCall.where).toMatchObject({
        name: { contains: 'push', mode: 'insensitive' },
      });
    });

    it('includes type filter in where clause when a valid protocol type is provided', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainingProtocolTemplate.findMany.mockResolvedValue([]);
      prisma.trainingProtocolTemplate.count.mockResolvedValue(0);

      await getProtocolTemplatesByTrainer('u1', { type: 'strength' });

      const findManyCall = prisma.trainingProtocolTemplate.findMany.mock.calls[0][0];
      expect(findManyCall.where).toMatchObject({ type: 'strength' });
    });

    it('silently ignores an invalid type filter value', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainingProtocolTemplate.findMany.mockResolvedValue([]);
      prisma.trainingProtocolTemplate.count.mockResolvedValue(0);

      await getProtocolTemplatesByTrainer('u1', { type: 'yoga' });

      const findManyCall = prisma.trainingProtocolTemplate.findMany.mock.calls[0][0];
      expect(findManyCall.where).not.toHaveProperty('type');
    });

    it('includes trainingLevel filter in where clause when a valid trainingLevel is provided', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainingProtocolTemplate.findMany.mockResolvedValue([]);
      prisma.trainingProtocolTemplate.count.mockResolvedValue(0);

      await getProtocolTemplatesByTrainer('u1', { trainingLevel: 'beginner' });

      const findManyCall = prisma.trainingProtocolTemplate.findMany.mock.calls[0][0];
      expect(findManyCall.where).toMatchObject({ trainingLevel: 'beginner' });
    });

    it('silently ignores an invalid trainingLevel filter value', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainingProtocolTemplate.findMany.mockResolvedValue([]);
      prisma.trainingProtocolTemplate.count.mockResolvedValue(0);

      await getProtocolTemplatesByTrainer('u1', { trainingLevel: 'expert' });

      const findManyCall = prisma.trainingProtocolTemplate.findMany.mock.calls[0][0];
      expect(findManyCall.where).not.toHaveProperty('trainingLevel');
    });

    it('calculates skip from custom page and limit', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainingProtocolTemplate.findMany.mockResolvedValue([]);
      prisma.trainingProtocolTemplate.count.mockResolvedValue(0);

      await getProtocolTemplatesByTrainer('u1', { page: 2, limit: 5 });

      const findManyCall = prisma.trainingProtocolTemplate.findMany.mock.calls[0][0];
      expect(findManyCall.skip).toBe(5); // (2-1)*5
      expect(findManyCall.take).toBe(5);
    });

    it('clamps limit to maximum of 100', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainingProtocolTemplate.findMany.mockResolvedValue([]);
      prisma.trainingProtocolTemplate.count.mockResolvedValue(0);

      const result = await getProtocolTemplatesByTrainer('u1', { limit: 200 });

      const findManyCall = prisma.trainingProtocolTemplate.findMany.mock.calls[0][0];
      expect(findManyCall.take).toBe(100);
      expect(result.limit).toBe(100);
    });

    it('strips _count from data items and exposes trainingsCount instead', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainingProtocolTemplate.findMany.mockResolvedValue([
        { ...baseTemplate, _count: { trainings: 5 } },
      ]);
      prisma.trainingProtocolTemplate.count.mockResolvedValue(1);

      const result = await getProtocolTemplatesByTrainer('u1');

      expect(result.data[0]).not.toHaveProperty('_count');
      expect(result.data[0].trainingsCount).toBe(5);
    });
  });

  // ==================== batchDeleteProtocolTemplates ====================

  describe('batchDeleteProtocolTemplates', () => {
    it('throws TRAINER_PROFILE_MISSING when trainer does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue(null);

      await expect(
        batchDeleteProtocolTemplates('u1', ['tmpl-1', 'tmpl-2']),
      ).rejects.toMatchObject({ code: 'TRAINER_PROFILE_MISSING', statusCode: 404 });

      expect(prisma.trainingProtocolTemplate.updateMany).not.toHaveBeenCalled();
    });

    it('calls updateMany with correct where clause and sets deletedAt', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainingProtocolTemplate.updateMany.mockResolvedValue({ count: 2 });

      await batchDeleteProtocolTemplates('u1', ['tmpl-1', 'tmpl-2']);

      expect(prisma.trainingProtocolTemplate.updateMany).toHaveBeenCalledWith({
        where: {
          id: { in: ['tmpl-1', 'tmpl-2'] },
          trainerId: 'trainer-1',
          deletedAt: null,
        },
        data: { deletedAt: expect.any(Date) },
      });
    });

    it('returns deletedCount matching the count from updateMany', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainingProtocolTemplate.updateMany.mockResolvedValue({ count: 2 });

      const result = await batchDeleteProtocolTemplates('u1', ['tmpl-1', 'tmpl-2']);

      expect(result).toEqual({ deletedCount: 2 });
    });

    it('returns deletedCount 0 when no owned IDs match', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainingProtocolTemplate.updateMany.mockResolvedValue({ count: 0 });

      const result = await batchDeleteProtocolTemplates('u1', ['tmpl-other', 'tmpl-gone']);

      expect(result).toEqual({ deletedCount: 0 });
    });
  });

  // ==================== getProtocolTemplateById ====================

  describe('getProtocolTemplateById', () => {
    it('throws TRAINER_PROFILE_MISSING when trainer does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue(null);

      await expect(getProtocolTemplateById('u1', 'tmpl-1')).rejects.toMatchObject({
        code: 'TRAINER_PROFILE_MISSING',
        statusCode: 404,
      });
    });

    it('throws TEMPLATE_NOT_FOUND when template does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainingProtocolTemplate.findUnique.mockResolvedValue(null);

      await expect(getProtocolTemplateById('u1', 'tmpl-x')).rejects.toMatchObject({
        code: 'TEMPLATE_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws TEMPLATE_NOT_FOUND when template is soft-deleted', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainingProtocolTemplate.findUnique.mockResolvedValue({
        ...baseTemplate,
        deletedAt: new Date(),
      });

      await expect(getProtocolTemplateById('u1', 'tmpl-1')).rejects.toMatchObject({
        code: 'TEMPLATE_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws FORBIDDEN_NOT_TEMPLATE_OWNER when trainer does not own the template', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainingProtocolTemplate.findUnique.mockResolvedValue({
        ...baseTemplate,
        trainerId: 'other-trainer',
      });

      await expect(getProtocolTemplateById('u1', 'tmpl-1')).rejects.toMatchObject({
        code: 'FORBIDDEN_NOT_TEMPLATE_OWNER',
        statusCode: 403,
      });
    });

    it('returns template with trainings', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      const templateWithTrainings = {
        ...baseTemplate,
        trainings: [
          {
            id: 'pt-1',
            weekDay: 'monday',
            order: 0,
            trainingTemplate: { id: 'tt-1', name: 'Bench Press', category: 'strength', bodySegment: 'upper' },
          },
        ],
      };
      prisma.trainingProtocolTemplate.findUnique.mockResolvedValue(templateWithTrainings);

      const result = await getProtocolTemplateById('u1', 'tmpl-1');

      expect(result).toEqual(templateWithTrainings);
      expect(result.trainings).toHaveLength(1);
      expect(result.trainings[0].trainingTemplate).toMatchObject({ name: 'Bench Press' });
    });
  });

  // ==================== updateProtocolTemplate ====================

  describe('updateProtocolTemplate', () => {
    it('throws TRAINER_PROFILE_MISSING when trainer does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue(null);

      await expect(updateProtocolTemplate('u1', 'tmpl-1', { name: 'New' })).rejects.toMatchObject({
        code: 'TRAINER_PROFILE_MISSING',
        statusCode: 404,
      });
    });

    it('throws TEMPLATE_NOT_FOUND when template does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainingProtocolTemplate.findUnique.mockResolvedValue(null);

      await expect(updateProtocolTemplate('u1', 'tmpl-x', { name: 'New' })).rejects.toMatchObject({
        code: 'TEMPLATE_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws FORBIDDEN_NOT_TEMPLATE_OWNER when trainer does not own the template', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainingProtocolTemplate.findUnique.mockResolvedValue({
        ...baseTemplate,
        trainerId: 'other-trainer',
      });

      await expect(updateProtocolTemplate('u1', 'tmpl-1', { name: 'New' })).rejects.toMatchObject({
        code: 'FORBIDDEN_NOT_TEMPLATE_OWNER',
        statusCode: 403,
      });
    });

    it('updates name without touching protocol template trainings', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainingProtocolTemplate.findUnique
        .mockResolvedValueOnce(baseTemplate)
        .mockResolvedValueOnce({ ...baseTemplate, name: 'Updated', trainings: [] });
      prisma.trainingProtocolTemplate.update.mockResolvedValue({ ...baseTemplate, name: 'Updated' });

      const result = await updateProtocolTemplate('u1', 'tmpl-1', { name: 'Updated' });

      expect(result.name).toBe('Updated');
      expect(prisma.protocolTemplateTraining.deleteMany).not.toHaveBeenCalled();
      expect(prisma.protocolTemplateTraining.createMany).not.toHaveBeenCalled();
    });

    it('throws INVALID_PROTOCOL_TYPE when type is invalid', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainingProtocolTemplate.findUnique.mockResolvedValue(baseTemplate);

      await expect(
        updateProtocolTemplate('u1', 'tmpl-1', { type: 'pilates' }),
      ).rejects.toMatchObject({ code: 'INVALID_PROTOCOL_TYPE' });

      expect(prisma.trainingProtocolTemplate.update).not.toHaveBeenCalled();
    });

    it('updates template type', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainingProtocolTemplate.findUnique
        .mockResolvedValueOnce(baseTemplate)
        .mockResolvedValueOnce({ ...baseTemplate, type: 'stretching', trainings: [] });
      prisma.trainingProtocolTemplate.update.mockResolvedValue({ ...baseTemplate, type: 'stretching' });

      await updateProtocolTemplate('u1', 'tmpl-1', { type: 'stretching' });

      expect(prisma.trainingProtocolTemplate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ type: 'stretching' }),
        }),
      );
    });

    it('replaces protocol template trainings atomically when trainings array is provided', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainingProtocolTemplate.findUnique
        .mockResolvedValueOnce(baseTemplate)
        .mockResolvedValueOnce({ ...baseTemplate, trainings: [{ id: 'pt-2', weekDay: 'monday' }] });
      prisma.trainingTemplate.findMany.mockResolvedValue([
        { id: 'tt-2', trainerId: 'trainer-1', isPublic: false },
      ]);
      prisma.trainingProtocolTemplate.update.mockResolvedValue(baseTemplate);
      prisma.protocolTemplateTraining.deleteMany.mockResolvedValue({ count: 1 });
      prisma.protocolTemplateTraining.createMany.mockResolvedValue({ count: 1 });

      await updateProtocolTemplate('u1', 'tmpl-1', {
        trainings: [{ trainingTemplateId: 'tt-2', weekDay: 'monday', order: 1 }],
      });

      expect(prisma.protocolTemplateTraining.deleteMany).toHaveBeenCalledWith({
        where: { protocolTemplateId: 'tmpl-1' },
      });
      expect(prisma.protocolTemplateTraining.createMany).toHaveBeenCalledWith({
        data: [{ protocolTemplateId: 'tmpl-1', trainingTemplateId: 'tt-2', weekDay: 'monday', order: 1 }],
      });
    });

    it('clears all protocol template trainings when trainings is an empty array', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainingProtocolTemplate.findUnique
        .mockResolvedValueOnce(baseTemplate)
        .mockResolvedValueOnce({ ...baseTemplate, trainings: [] });
      prisma.trainingProtocolTemplate.update.mockResolvedValue(baseTemplate);
      prisma.protocolTemplateTraining.deleteMany.mockResolvedValue({ count: 2 });

      await updateProtocolTemplate('u1', 'tmpl-1', { trainings: [] });

      expect(prisma.protocolTemplateTraining.deleteMany).toHaveBeenCalledWith({
        where: { protocolTemplateId: 'tmpl-1' },
      });
      expect(prisma.protocolTemplateTraining.createMany).not.toHaveBeenCalled();
    });
  });

  // ==================== deleteProtocolTemplate ====================

  describe('deleteProtocolTemplate', () => {
    it('throws TRAINER_PROFILE_MISSING when trainer does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue(null);

      await expect(deleteProtocolTemplate('u1', 'tmpl-1')).rejects.toMatchObject({
        code: 'TRAINER_PROFILE_MISSING',
        statusCode: 404,
      });
    });

    it('throws TEMPLATE_NOT_FOUND when template does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainingProtocolTemplate.findUnique.mockResolvedValue(null);

      await expect(deleteProtocolTemplate('u1', 'tmpl-x')).rejects.toMatchObject({
        code: 'TEMPLATE_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws FORBIDDEN_NOT_TEMPLATE_OWNER when trainer does not own the template', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainingProtocolTemplate.findUnique.mockResolvedValue({
        ...baseTemplate,
        trainerId: 'other-trainer',
      });

      await expect(deleteProtocolTemplate('u1', 'tmpl-1')).rejects.toMatchObject({
        code: 'FORBIDDEN_NOT_TEMPLATE_OWNER',
        statusCode: 403,
      });
    });

    it('soft deletes the template', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainingProtocolTemplate.findUnique.mockResolvedValue(baseTemplate);
      const deleted = { ...baseTemplate, deletedAt: new Date() };
      prisma.trainingProtocolTemplate.update.mockResolvedValue(deleted);

      const result = await deleteProtocolTemplate('u1', 'tmpl-1');

      expect(result.deletedAt).toBeTruthy();
      expect(prisma.trainingProtocolTemplate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'tmpl-1' },
          data: expect.objectContaining({ deletedAt: expect.any(Date) }),
        }),
      );
    });
  });
});
