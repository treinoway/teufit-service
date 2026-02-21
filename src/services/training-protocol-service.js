import { prisma } from '../db.js';
import { trainingStatusValues } from '../constants/training.js';
import { buildError, validateWeekDays, validateGenderOrdination, validateTrainingLevel } from '../helpers/training-validators.js';
import { formatDateOnly, parseDateOnlyAsUtc } from '../helpers/date-helpers.js';

/**
 * Validate status
 */
function validateStatus(status) {
  if (!trainingStatusValues.includes(status)) {
    throw buildError(
      'INVALID_STATUS',
      `Invalid status: ${status}. Valid values are: ${trainingStatusValues.join(', ')}`,
    );
  }
}

function normalizeProtocolDateFields(protocol) {
  if (!protocol) return protocol;

  const normalizedProtocol = { ...protocol };

  if (protocol.startDate !== undefined) {
    normalizedProtocol.startDate = formatDateOnly(protocol.startDate);
  }

  if (protocol.expirationDate !== undefined) {
    normalizedProtocol.expirationDate = formatDateOnly(protocol.expirationDate);
  }

  return normalizedProtocol;
}

/**
 * Create a new training protocol for a user (TRAINER only)
 *
 * @param {string} userId - User ID of the trainer
 * @param {object} data - Protocol data
 * @returns {Promise<object>} Created protocol
 */
export async function createProtocol(userId, data) {
  // 1. Verify trainer profile exists
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  // 2. Verify assignee (user) exists and is not soft-deleted
  const assignee = await prisma.user.findUnique({
    where: { id: data.assigneeId },
    select: { id: true, deletedAt: true },
  });

  if (!assignee || assignee.deletedAt) {
    throw buildError('ASSIGNEE_NOT_FOUND', 'Assignee user not found', 404);
  }

  // 3. Validate week days
  if (data.availableWeekDays && data.availableWeekDays.length > 0) {
    validateWeekDays(data.availableWeekDays, 'availableWeekDays');
  }

  // 4. Validate status if provided
  if (data.status) {
    validateStatus(data.status);
  }

  // 5. Validate new enum fields if provided
  validateGenderOrdination(data.genderOrdination);
  validateTrainingLevel(data.trainingLevel);

  // 6. Create protocol
  const protocol = await prisma.trainingProtocol.create({
    data: {
      trainerId: trainer.id,
      assigneeId: data.assigneeId,
      protocolTemplateId: data.protocolTemplateId || null,
      name: data.name,
      description: data.description || null,
      availableWeekDays: data.availableWeekDays || [],
      status: data.status || 'active',
      startDate: parseDateOnlyAsUtc(data.startDate),
      expirationDate: parseDateOnlyAsUtc(data.expirationDate),
      genderOrdination: data.genderOrdination || null,
      trainingLevel: data.trainingLevel || null,
    },
    include: {
      assignee: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          avatarUrl: true,
        },
      },
    },
  });

  return normalizeProtocolDateFields(protocol);
}

/**
 * Get protocols created by a trainer
 *
 * @param {string} userId - User ID of the trainer
 * @param {object} filters - Optional filters
 * @param {string} [filters.status] - Filter by status
 * @param {string} [filters.assigneeId] - Filter by assignee user ID
 * @returns {Promise<object[]>} List of protocols
 */
export async function getProtocolsByTrainer(userId, filters = {}) {
  // 1. Verify trainer profile exists
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  // 2. Build where clause
  const where = {
    trainerId: trainer.id,
    deletedAt: null,
  };

  if (filters.status) {
    validateStatus(filters.status);
    where.status = filters.status;
  }

  if (filters.assigneeId) {
    where.assigneeId = filters.assigneeId;
  }

  // 3. Fetch protocols
  const protocols = await prisma.trainingProtocol.findMany({
    where,
    include: {
      assignee: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          avatarUrl: true,
        },
      },
      protocolTemplate: {
        select: {
          id: true,
          name: true,
        },
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  return protocols.map(normalizeProtocolDateFields);
}

/**
 * Get protocols assigned to a user (assignee)
 *
 * @param {string} userId - User ID of the assignee
 * @param {object} filters - Optional filters
 * @param {string} [filters.status] - Filter by status
 * @returns {Promise<object[]>} List of protocols
 */
export async function getMyProtocols(userId, filters = {}) {
  // 1. Build where clause (protocols assigned to this user)
  const where = {
    assigneeId: userId,
    deletedAt: null,
  };

  // Assignees should not see archived protocols by default
  if (filters.status) {
    validateStatus(filters.status);
    where.status = filters.status;
  } else {
    where.status = { in: ['active', 'completed'] };
  }

  // 3. Fetch protocols
  const protocols = await prisma.trainingProtocol.findMany({
    where,
    include: {
      trainer: {
        include: {
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              avatarUrl: true,
            },
          },
        },
      },
      trainings: {
        where: { deletedAt: null },
        include: {
          schedules: {
            orderBy: { order: 'asc' },
          },
        },
      },
    },
    orderBy: {
      startDate: 'desc',
    },
  });

  // Map trainer.user to trainer for cleaner response
  return protocols.map((protocol) => ({
    ...normalizeProtocolDateFields(protocol),
    trainer: protocol.trainer?.user || null,
  }));
}

/**
 * Get a single protocol by ID
 *
 * @param {string} userId - User ID
 * @param {string} protocolId - Protocol ID
 * @param {string} context - Context: 'trainer' or 'student'
 * @returns {Promise<object>} Protocol
 */
export async function getProtocolById(userId, protocolId, context) {
  // 1. Fetch protocol with full details
  const protocol = await prisma.trainingProtocol.findUnique({
    where: { id: protocolId },
    include: {
      assignee: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          avatarUrl: true,
        },
      },
      trainer: {
        include: {
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              avatarUrl: true,
            },
          },
        },
      },
      protocolTemplate: {
        select: {
          id: true,
          name: true,
        },
      },
      trainings: {
        where: { deletedAt: null },
        include: {
          schedules: {
            orderBy: { order: 'asc' },
          },
        },
        orderBy: { order: 'asc' },
      },
    },
  });

  if (!protocol || protocol.deletedAt) {
    throw buildError('PROTOCOL_NOT_FOUND', 'Protocol not found', 404);
  }

  // 2. Verify access based on context
  if (context === 'trainer') {
    const trainer = await prisma.trainer.findUnique({
      where: { userId },
      select: { id: true },
    });

    if (!trainer) {
      throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
    }

    if (protocol.trainerId !== trainer.id) {
      throw buildError('FORBIDDEN_NOT_PROTOCOL_OWNER', 'You do not own this protocol', 403);
    }
  } else if (context === 'assignee') {
    if (protocol.assigneeId !== userId) {
      throw buildError('FORBIDDEN_NOT_YOUR_PROTOCOL', 'This protocol is not assigned to you', 403);
    }

    // Map trainer.user to trainer for cleaner response
    const { trainer, ...rest } = protocol;
    return {
      ...normalizeProtocolDateFields(rest),
      trainer: trainer?.user || null,
    };
  } else {
    throw buildError('INVALID_CONTEXT', 'Context must be either "trainer" or "assignee"');
  }

  return normalizeProtocolDateFields(protocol);
}

/**
 * Update a training protocol
 *
 * @param {string} userId - User ID of the trainer
 * @param {string} protocolId - Protocol ID
 * @param {object} data - Update data
 * @returns {Promise<object>} Updated protocol
 */
export async function updateProtocol(userId, protocolId, data) {
  // 1. Verify trainer profile exists
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  // 2. Verify protocol exists and ownership
  const protocol = await prisma.trainingProtocol.findUnique({
    where: { id: protocolId },
  });

  if (!protocol || protocol.deletedAt) {
    throw buildError('PROTOCOL_NOT_FOUND', 'Protocol not found', 404);
  }

  if (protocol.trainerId !== trainer.id) {
    throw buildError('FORBIDDEN_NOT_PROTOCOL_OWNER', 'You do not own this protocol', 403);
  }

  // 3. Validate week days if provided
  if (data.availableWeekDays && data.availableWeekDays.length > 0) {
    validateWeekDays(data.availableWeekDays, 'availableWeekDays');
  }

  // 4. Validate status if provided
  if (data.status) {
    validateStatus(data.status);
  }

  // 5. Validate new enum fields if provided
  validateGenderOrdination(data.genderOrdination);
  validateTrainingLevel(data.trainingLevel);

  // 6. Build update data
  const updateData = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.description !== undefined) updateData.description = data.description;
  if (data.availableWeekDays !== undefined) updateData.availableWeekDays = data.availableWeekDays;
  if (data.status !== undefined) updateData.status = data.status;
  if (data.startDate !== undefined) updateData.startDate = parseDateOnlyAsUtc(data.startDate);
  if (data.expirationDate !== undefined) {
    updateData.expirationDate = parseDateOnlyAsUtc(data.expirationDate);
  }
  if (data.genderOrdination !== undefined) updateData.genderOrdination = data.genderOrdination;
  if (data.trainingLevel !== undefined) updateData.trainingLevel = data.trainingLevel;

  // 6. Update protocol
  const updated = await prisma.trainingProtocol.update({
    where: { id: protocolId },
    data: updateData,
    include: {
      assignee: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          avatarUrl: true,
        },
      },
    },
  });

  return normalizeProtocolDateFields(updated);
}

/**
 * Soft delete a protocol
 *
 * @param {string} userId - User ID of the trainer
 * @param {string} protocolId - Protocol ID
 * @returns {Promise<object>} Deleted protocol
 */
export async function deleteProtocol(userId, protocolId) {
  // 1. Verify trainer profile exists
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  // 2. Verify protocol exists and ownership
  const protocol = await prisma.trainingProtocol.findUnique({
    where: { id: protocolId },
  });

  if (!protocol || protocol.deletedAt) {
    throw buildError('PROTOCOL_NOT_FOUND', 'Protocol not found', 404);
  }

  if (protocol.trainerId !== trainer.id) {
    throw buildError('FORBIDDEN_NOT_PROTOCOL_OWNER', 'You do not own this protocol', 403);
  }

  // 3. Soft delete
  const deleted = await prisma.trainingProtocol.update({
    where: { id: protocolId },
    data: {
      deletedAt: new Date(),
    },
  });

  return normalizeProtocolDateFields(deleted);
}

/**
 * Create a protocol from a template
 *
 * @param {string} userId - User ID of the trainer
 * @param {string} templateId - Template ID
 * @param {string} assigneeId - User ID of the assignee
 * @param {object} data - Additional protocol data
 * @returns {Promise<object>} Created protocol
 */
export async function importFromTemplate(userId, templateId, assigneeId, data = {}) {
  // 1. Verify trainer profile exists
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  // 2. Verify template exists and ownership (include schedule templates)
  const template = await prisma.trainingProtocolTemplate.findUnique({
    where: { id: templateId },
    include: {
      scheduleTemplates: {
        include: {
          trainingTemplate: true,
        },
        orderBy: [{ weekDay: 'asc' }, { order: 'asc' }],
      },
    },
  });

  if (!template || template.deletedAt) {
    throw buildError('TEMPLATE_NOT_FOUND', 'Protocol template not found', 404);
  }

  if (template.trainerId !== trainer.id) {
    throw buildError('FORBIDDEN_NOT_TEMPLATE_OWNER', 'You do not own this template', 403);
  }

  // 3. Verify assignee (user) exists and is not soft-deleted
  const assignee = await prisma.user.findUnique({
    where: { id: assigneeId },
    select: { id: true, deletedAt: true },
  });

  if (!assignee || assignee.deletedAt) {
    throw buildError('ASSIGNEE_NOT_FOUND', 'Assignee user not found', 404);
  }

  // 4. Create protocol, trainings, and schedules in a transaction
  const protocol = await prisma.$transaction(async (tx) => {
    const created = await tx.trainingProtocol.create({
      data: {
        trainerId: trainer.id,
        assigneeId,
        protocolTemplateId: template.id,
        name: data.name || template.name,
        description: data.description || template.description,
        availableWeekDays: data.availableWeekDays || template.availableWeekDays,
        status: 'active',
        startDate: data.startDate ? parseDateOnlyAsUtc(data.startDate) : new Date(),
        expirationDate: parseDateOnlyAsUtc(data.expirationDate),
        genderOrdination: data.genderOrdination ?? template.genderOrdination ?? null,
        trainingLevel: data.trainingLevel ?? template.trainingLevel ?? null,
      },
    });

    for (const scheduleTemplate of template.scheduleTemplates) {
      const { trainingTemplate } = scheduleTemplate;

      const training = await tx.training.create({
        data: {
          trainingProtocolId: created.id,
          trainingTemplateId: trainingTemplate.id,
          name: trainingTemplate.name,
          description: trainingTemplate.description,
          category: trainingTemplate.category,
          bodySegment: trainingTemplate.bodySegment,
          order: scheduleTemplate.order,
        },
      });

      await tx.trainingSchedule.create({
        data: {
          trainingProtocolId: created.id,
          trainingId: training.id,
          weekDay: scheduleTemplate.weekDay,
          order: scheduleTemplate.order,
        },
      });
    }

    return tx.trainingProtocol.findUnique({
      where: { id: created.id },
      include: {
        assignee: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            avatarUrl: true,
          },
        },
        trainings: {
          where: { deletedAt: null },
          include: {
            schedules: { orderBy: { order: 'asc' } },
          },
          orderBy: { order: 'asc' },
        },
      },
    });
  });

  return normalizeProtocolDateFields(protocol);
}
