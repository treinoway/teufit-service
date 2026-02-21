import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    trainer: { findUnique: vi.fn() },
    trainingProtocolTemplate: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    trainingTemplate: { findMany: vi.fn() },
    trainingScheduleTemplate: {
      createMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

import { prisma } from '../../src/db.js';
import {
  createProtocolTemplate,
  getProtocolTemplatesByTrainer,
  getProtocolTemplateById,
  updateProtocolTemplate,
  deleteProtocolTemplate,
} from '../../src/services/training-protocol-template-service.js';

const baseTemplate = {
  id: 'tmpl-1',
  trainerId: 'trainer-1',
  name: 'Test Template',
  description: null,
  availableWeekDays: ['monday', 'wednesday'],
  defaultDurationWeeks: null,
  genderOrdination: null,
  trainingLevel: null,
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: null,
  scheduleTemplates: [],
  scheduleTemplatesCount: 0,
};

describe('training-protocol-template-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default $transaction passthrough
    prisma.$transaction.mockImplementation(async (fn) => fn(prisma));
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

    it('throws INVALID_WEEK_DAYS when availableWeekDays contains invalid values', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });

      await expect(
        createProtocolTemplate('u1', { name: 'T', availableWeekDays: ['monday', 'funday'] }),
      ).rejects.toMatchObject({ code: 'INVALID_WEEK_DAYS' });
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

    it('creates template without trainings', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainingProtocolTemplate.create.mockResolvedValue({ id: 'tmpl-1' });
      prisma.trainingProtocolTemplate.findUnique.mockResolvedValue(baseTemplate);

      const result = await createProtocolTemplate('u1', { name: 'Test Template' });

      expect(result).toEqual(baseTemplate);
      expect(prisma.trainingProtocolTemplate.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            trainerId: 'trainer-1',
            name: 'Test Template',
          }),
        }),
      );
      expect(prisma.trainingScheduleTemplate.createMany).not.toHaveBeenCalled();
    });

    it('throws TRAINING_TEMPLATE_NOT_FOUND when a training template in trainings does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainingTemplate.findMany.mockResolvedValue([]);

      await expect(
        createProtocolTemplate('u1', {
          name: 'T',
          availableWeekDays: ['monday'],
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
          availableWeekDays: ['monday'],
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
      const resultTemplate = { ...baseTemplate, scheduleTemplates: [{ id: 'st-1', weekDay: 'monday' }] };
      prisma.trainingProtocolTemplate.findUnique.mockResolvedValue(resultTemplate);

      const result = await createProtocolTemplate('u1', {
        name: 'T',
        availableWeekDays: ['monday'],
        trainings: [{ trainingTemplateId: 'tt-1', weekDay: 'monday', order: 0 }],
      });

      expect(prisma.trainingScheduleTemplate.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.arrayContaining([
            expect.objectContaining({ trainingTemplateId: 'tt-1', weekDay: 'monday' }),
          ]),
        }),
      );
      expect(result.scheduleTemplates).toHaveLength(1);
    });

    it('throws INVALID_WEEK_DAY_FOR_SCHEDULE when training weekDay is not in availableWeekDays', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainingTemplate.findMany.mockResolvedValue([
        { id: 'tt-1', trainerId: 'trainer-1', isPublic: false },
      ]);

      await expect(
        createProtocolTemplate('u1', {
          name: 'T',
          availableWeekDays: ['monday'],
          trainings: [{ trainingTemplateId: 'tt-1', weekDay: 'friday', order: 0 }],
        }),
      ).rejects.toMatchObject({ code: 'INVALID_WEEK_DAY_FOR_SCHEDULE', statusCode: 400 });
    });

    it('creates schedule templates when trainings are provided', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainingTemplate.findMany.mockResolvedValue([
        { id: 'tt-1', trainerId: 'trainer-1', isPublic: false },
      ]);
      prisma.trainingProtocolTemplate.create.mockResolvedValue({ id: 'tmpl-1' });
      const resultTemplate = { ...baseTemplate, scheduleTemplates: [{ id: 'st-1', weekDay: 'monday', order: 0, trainingTemplate: { id: 'tt-1', name: 'Bench Press', category: 'strength', bodySegment: 'upper' } }] };
      prisma.trainingProtocolTemplate.findUnique.mockResolvedValue(resultTemplate);

      await createProtocolTemplate('u1', {
        name: 'T',
        availableWeekDays: ['monday'],
        trainings: [{ trainingTemplateId: 'tt-1', weekDay: 'monday', order: 0 }],
      });

      expect(prisma.trainingScheduleTemplate.createMany).toHaveBeenCalledWith({
        data: [{ protocolTemplateId: 'tmpl-1', trainingTemplateId: 'tt-1', weekDay: 'monday', order: 0 }],
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

    it('returns templates with scheduleTemplatesCount', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainingProtocolTemplate.findMany.mockResolvedValue([
        { ...baseTemplate, _count: { scheduleTemplates: 3 } },
      ]);

      const result = await getProtocolTemplatesByTrainer('u1');

      expect(result).toHaveLength(1);
      expect(result[0].scheduleTemplatesCount).toBe(3);
      expect(result[0]._count).toBeUndefined();
    });

    it('returns empty array when trainer has no templates', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainingProtocolTemplate.findMany.mockResolvedValue([]);

      const result = await getProtocolTemplatesByTrainer('u1');

      expect(result).toEqual([]);
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

    it('returns template with scheduleTemplates', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      const templateWithSchedules = {
        ...baseTemplate,
        scheduleTemplates: [
          {
            id: 'st-1',
            weekDay: 'monday',
            order: 0,
            trainingTemplate: { id: 'tt-1', name: 'Bench Press', category: 'strength', bodySegment: 'upper' },
          },
        ],
      };
      prisma.trainingProtocolTemplate.findUnique.mockResolvedValue(templateWithSchedules);

      const result = await getProtocolTemplateById('u1', 'tmpl-1');

      expect(result).toEqual(templateWithSchedules);
      expect(result.scheduleTemplates).toHaveLength(1);
      expect(result.scheduleTemplates[0].trainingTemplate).toMatchObject({ name: 'Bench Press' });
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

    it('updates name without touching schedule templates', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainingProtocolTemplate.findUnique
        .mockResolvedValueOnce(baseTemplate)
        .mockResolvedValueOnce({ ...baseTemplate, name: 'Updated', scheduleTemplates: [] });
      prisma.trainingProtocolTemplate.update.mockResolvedValue({ ...baseTemplate, name: 'Updated' });

      const result = await updateProtocolTemplate('u1', 'tmpl-1', { name: 'Updated' });

      expect(result.name).toBe('Updated');
      expect(prisma.trainingScheduleTemplate.deleteMany).not.toHaveBeenCalled();
      expect(prisma.trainingScheduleTemplate.createMany).not.toHaveBeenCalled();
    });

    it('replaces schedule templates atomically when trainings array is provided', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainingProtocolTemplate.findUnique
        .mockResolvedValueOnce(baseTemplate)
        .mockResolvedValueOnce({ ...baseTemplate, scheduleTemplates: [{ id: 'st-2', weekDay: 'monday' }] });
      prisma.trainingTemplate.findMany.mockResolvedValue([
        { id: 'tt-2', trainerId: 'trainer-1', isPublic: false },
      ]);
      prisma.trainingProtocolTemplate.update.mockResolvedValue(baseTemplate);
      prisma.trainingScheduleTemplate.deleteMany.mockResolvedValue({ count: 1 });
      prisma.trainingScheduleTemplate.createMany.mockResolvedValue({ count: 1 });

      await updateProtocolTemplate('u1', 'tmpl-1', {
        trainings: [{ trainingTemplateId: 'tt-2', weekDay: 'monday', order: 1 }],
      });

      expect(prisma.trainingScheduleTemplate.deleteMany).toHaveBeenCalledWith({
        where: { protocolTemplateId: 'tmpl-1' },
      });
      expect(prisma.trainingScheduleTemplate.createMany).toHaveBeenCalledWith({
        data: [{ protocolTemplateId: 'tmpl-1', trainingTemplateId: 'tt-2', weekDay: 'monday', order: 1 }],
      });
    });

    it('clears all schedule templates when trainings is an empty array', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainingProtocolTemplate.findUnique
        .mockResolvedValueOnce(baseTemplate)
        .mockResolvedValueOnce({ ...baseTemplate, scheduleTemplates: [] });
      prisma.trainingProtocolTemplate.update.mockResolvedValue(baseTemplate);
      prisma.trainingScheduleTemplate.deleteMany.mockResolvedValue({ count: 2 });

      await updateProtocolTemplate('u1', 'tmpl-1', { trainings: [] });

      expect(prisma.trainingScheduleTemplate.deleteMany).toHaveBeenCalledWith({
        where: { protocolTemplateId: 'tmpl-1' },
      });
      expect(prisma.trainingScheduleTemplate.createMany).not.toHaveBeenCalled();
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
