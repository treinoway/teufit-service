import { AppError } from '../errors/app-error.js';
import { DietErrorCode, DietMessageCode, dietProtocolStatusValues } from '../constants/diet.js';
import { formatDateOnly, parseDateOnlyAsUtc } from '../helpers/date-helpers.js';

function buildDietError(errorCode, messageCode, message, httpStatus = 400) {
  return new AppError({ httpStatus, error: errorCode, messageCode, message });
}

async function resolveNutritionistId(db, nutritionistUserId) {
  const nutritionist = await db.nutritionist.findUnique({
    where: { userId: nutritionistUserId },
    select: { id: true },
  });

  if (!nutritionist) {
    throw buildDietError('NUTRITIONIST_NOT_FOUND', 'nutritionist.notFound', 'Nutritionist profile not found.', 404);
  }

  return nutritionist.id;
}

const DECIMAL_FIELDS = ['tmbKcal', 'getKcal', 'dailyCaloricTarget'];
const FOOD_ITEM_DECIMAL_FIELDS = ['quantityG', 'energyKcal', 'proteinG', 'carbohydratesG', 'totalFatG', 'fiberG'];

function toNumber(value) {
  return value != null ? Number(value) : null;
}

function normalizeProtocolDates(protocol) {
  if (!protocol) return protocol;
  const result = { ...protocol };
  if (protocol.startDate !== undefined) result.startDate = formatDateOnly(protocol.startDate);
  if (protocol.expirationDate !== undefined) result.expirationDate = formatDateOnly(protocol.expirationDate);
  for (const field of DECIMAL_FIELDS) {
    if (protocol[field] !== undefined) result[field] = toNumber(protocol[field]);
  }
  if (Array.isArray(protocol.meals)) {
    result.meals = protocol.meals.map((meal) => ({
      ...meal,
      foodItems: Array.isArray(meal.foodItems)
        ? meal.foodItems.map((item) => {
            const normalized = { ...item };
            for (const field of FOOD_ITEM_DECIMAL_FIELDS) {
              if (item[field] !== undefined) normalized[field] = toNumber(item[field]);
            }
            return normalized;
          })
        : meal.foodItems,
    }));
  }
  return result;
}

const PROTOCOL_INCLUDE_BASE = {
  assignee: {
    select: { id: true, firstName: true, lastName: true, avatarUrl: true },
  },
};

const PROTOCOL_INCLUDE_FULL = {
  ...PROTOCOL_INCLUDE_BASE,
  meals: {
    where: { deletedAt: null },
    orderBy: { order: 'asc' },
    include: {
      foodItems: {
        where: { deletedAt: null },
        orderBy: { order: 'asc' },
      },
    },
  },
};

/**
 * Create a new diet protocol.
 *
 * @param {object} db - Prisma client
 * @param {string} nutritionistUserId - User ID of the nutritionist
 * @param {object} data - Protocol data
 * @returns {Promise<object>} Created protocol
 */
export async function createProtocol(db, nutritionistUserId, data) {
  const nutritionistId = await resolveNutritionistId(db, nutritionistUserId);

  const assignee = await db.user.findUnique({
    where: { id: data.assigneeId },
    select: { id: true, deletedAt: true },
  });

  if (!assignee || assignee.deletedAt) {
    throw buildDietError(
      DietErrorCode.PATIENT_NOT_FOUND,
      DietMessageCode.PATIENT_NOT_FOUND,
      'Patient not found.',
      404,
    );
  }

  const link = await db.nutritionistPatient.findUnique({
    where: {
      nutritionistId_patientId: { nutritionistId, patientId: data.assigneeId },
    },
  });

  if (!link || link.deletedAt) {
    throw buildDietError(
      DietErrorCode.PATIENT_NOT_LINKED,
      DietMessageCode.PATIENT_NOT_LINKED,
      'Patient is not linked to this nutritionist.',
      400,
    );
  }

  const protocol = await db.dietProtocol.create({
    data: {
      nutritionistId,
      assigneeId: data.assigneeId,
      dietProtocolTemplateId: data.dietProtocolTemplateId || null,
      name: data.name,
      description: data.description || null,
      status: data.status || 'active',
      startDate: parseDateOnlyAsUtc(data.startDate),
      expirationDate: parseDateOnlyAsUtc(data.expirationDate),
      dietType: data.dietType || null,
      goalType: data.goalType || null,
      tmbFormula: data.tmbFormula || null,
      tmbKcal: data.tmbKcal || null,
      activityLevel: data.activityLevel || null,
      getKcal: data.getKcal || null,
      dailyCaloricTarget: data.dailyCaloricTarget || null,
      notes: data.notes || null,
    },
    include: PROTOCOL_INCLUDE_BASE,
  });

  return normalizeProtocolDates(protocol);
}

/**
 * Create a diet protocol from a template, copying all meals and food items.
 *
 * @param {object} db - Prisma client
 * @param {string} nutritionistUserId - User ID of the nutritionist
 * @param {string} templateId - Template UUID
 * @param {object} data - Protocol override data
 * @returns {Promise<object>} Created protocol
 */
export async function importFromTemplate(db, nutritionistUserId, templateId, data) {
  const nutritionistId = await resolveNutritionistId(db, nutritionistUserId);

  const template = await db.dietProtocolTemplate.findUnique({
    where: { id: templateId },
    include: {
      meals: {
        where: { deletedAt: null },
        orderBy: { order: 'asc' },
        include: {
          foodItems: {
            where: { deletedAt: null },
            orderBy: { order: 'asc' },
          },
        },
      },
    },
  });

  if (!template || template.deletedAt) {
    throw buildDietError(
      DietErrorCode.TEMPLATE_NOT_FOUND,
      DietMessageCode.TEMPLATE_NOT_FOUND,
      'Diet template not found.',
      404,
    );
  }

  if (template.nutritionistId !== nutritionistId) {
    throw buildDietError(
      DietErrorCode.FORBIDDEN_NOT_TEMPLATE_OWNER,
      DietMessageCode.FORBIDDEN_NOT_TEMPLATE_OWNER,
      'You do not own this template.',
      403,
    );
  }

  const assignee = await db.user.findUnique({
    where: { id: data.assigneeId },
    select: { id: true, deletedAt: true },
  });

  if (!assignee || assignee.deletedAt) {
    throw buildDietError(
      DietErrorCode.PATIENT_NOT_FOUND,
      DietMessageCode.PATIENT_NOT_FOUND,
      'Patient not found.',
      404,
    );
  }

  const link = await db.nutritionistPatient.findUnique({
    where: {
      nutritionistId_patientId: { nutritionistId, patientId: data.assigneeId },
    },
  });

  if (!link || link.deletedAt) {
    throw buildDietError(
      DietErrorCode.PATIENT_NOT_LINKED,
      DietMessageCode.PATIENT_NOT_LINKED,
      'Patient is not linked to this nutritionist.',
      400,
    );
  }

  const protocol = await db.$transaction(async (tx) => {
    const created = await tx.dietProtocol.create({
      data: {
        nutritionistId,
        assigneeId: data.assigneeId,
        dietProtocolTemplateId: template.id,
        name: data.name ?? template.name,
        description: data.description ?? template.description,
        status: 'active',
        startDate: data.startDate ? parseDateOnlyAsUtc(data.startDate) : new Date(),
        expirationDate: parseDateOnlyAsUtc(data.expirationDate),
        dietType: data.dietType ?? template.dietType ?? null,
        goalType: data.goalType ?? template.goalType ?? null,
        tmbFormula: data.tmbFormula ?? null,
        tmbKcal: data.tmbKcal ?? null,
        activityLevel: data.activityLevel ?? null,
        getKcal: data.getKcal ?? null,
        dailyCaloricTarget: data.dailyCaloricTarget ?? null,
        notes: data.notes ?? null,
      },
    });

    for (const meal of template.meals) {
      const createdMeal = await tx.dietMeal.create({
        data: {
          dietProtocolId: created.id,
          templateMealId: meal.id,
          name: meal.name,
          mealType: meal.mealType,
          order: meal.order,
          scheduledTime: meal.scheduledTime || null,
          notes: meal.notes || null,
        },
      });

      for (const item of meal.foodItems) {
        await tx.dietFoodItem.create({
          data: {
            dietMealId: createdMeal.id,
            foodId: item.foodId || null,
            foodName: item.foodName,
            quantityG: item.quantityG,
            unit: item.unit,
            order: item.order,
            notes: item.notes || null,
            energyKcal: item.energyKcal,
            proteinG: item.proteinG,
            carbohydratesG: item.carbohydratesG,
            totalFatG: item.totalFatG,
            fiberG: item.fiberG,
          },
        });
      }
    }

    return tx.dietProtocol.findUnique({
      where: { id: created.id },
      include: {
        ...PROTOCOL_INCLUDE_FULL,
      },
    });
  });

  return normalizeProtocolDates(protocol);
}

/**
 * List diet protocols created by a nutritionist with optional filters.
 *
 * @param {object} db - Prisma client
 * @param {string} nutritionistUserId - User ID of the nutritionist
 * @param {{ status?: string, assigneeId?: string }} filters
 * @returns {Promise<object[]>} List of protocols
 */
export async function listProtocols(db, nutritionistUserId, filters = {}) {
  const nutritionistId = await resolveNutritionistId(db, nutritionistUserId);

  if (filters.status && !dietProtocolStatusValues.includes(filters.status)) {
    throw new AppError({
      httpStatus: 400,
      error: 'INVALID_STATUS',
      messageCode: 'validation.failed',
      message: `Invalid status: ${filters.status}`,
    });
  }

  const where = { nutritionistId, deletedAt: null };
  if (filters.status) where.status = filters.status;
  if (filters.assigneeId) where.assigneeId = filters.assigneeId;

  const protocols = await db.dietProtocol.findMany({
    where,
    include: PROTOCOL_INCLUDE_BASE,
    orderBy: { createdAt: 'desc' },
  });

  return protocols.map(normalizeProtocolDates);
}

/**
 * Get a single diet protocol by ID.
 *
 * @param {object} db - Prisma client
 * @param {string} userId - User ID (nutritionist or patient depending on context)
 * @param {string} protocolId - Protocol UUID
 * @param {'nutritionist' | 'assignee'} context
 * @returns {Promise<object>} Protocol
 */
export async function getProtocolById(db, userId, protocolId, context) {
  const protocol = await db.dietProtocol.findUnique({
    where: { id: protocolId },
    include: {
      assignee: {
        select: { id: true, firstName: true, lastName: true, avatarUrl: true },
      },
      nutritionist: {
        include: {
          user: {
            select: { id: true, firstName: true, lastName: true, avatarUrl: true },
          },
        },
      },
      template: { select: { id: true, name: true } },
      meals: {
        where: { deletedAt: null },
        orderBy: { order: 'asc' },
        include: {
          foodItems: {
            where: { deletedAt: null },
            orderBy: { order: 'asc' },
          },
        },
      },
    },
  });

  if (!protocol || protocol.deletedAt) {
    throw buildDietError(
      DietErrorCode.PROTOCOL_NOT_FOUND,
      DietMessageCode.PROTOCOL_NOT_FOUND,
      'Diet protocol not found.',
      404,
    );
  }

  if (context === 'nutritionist') {
    const nutritionistId = await resolveNutritionistId(db, userId);
    if (protocol.nutritionistId !== nutritionistId) {
      throw buildDietError(
        DietErrorCode.FORBIDDEN_NOT_PROTOCOL_OWNER,
        DietMessageCode.FORBIDDEN_NOT_PROTOCOL_OWNER,
        'You do not own this protocol.',
        403,
      );
    }
    return normalizeProtocolDates(protocol);
  }

  if (context === 'assignee') {
    if (protocol.assigneeId !== userId) {
      throw buildDietError(
        DietErrorCode.FORBIDDEN_NOT_YOUR_PROTOCOL,
        DietMessageCode.FORBIDDEN_NOT_YOUR_PROTOCOL,
        'This protocol is not assigned to you.',
        403,
      );
    }
    const { nutritionist, ...rest } = protocol;
    return {
      ...normalizeProtocolDates(rest),
      nutritionist: nutritionist?.user || null,
    };
  }

  throw new AppError({
    httpStatus: 500,
    error: 'INVALID_CONTEXT',
    messageCode: 'internal.serverError',
    message: 'Invalid context value.',
  });
}

/**
 * Update a diet protocol.
 *
 * @param {object} db - Prisma client
 * @param {string} nutritionistUserId - User ID of the nutritionist
 * @param {string} protocolId - Protocol UUID
 * @param {object} data - Update data
 * @returns {Promise<object>} Updated protocol
 */
export async function updateProtocol(db, nutritionistUserId, protocolId, data) {
  const nutritionistId = await resolveNutritionistId(db, nutritionistUserId);

  const protocol = await db.dietProtocol.findUnique({ where: { id: protocolId } });

  if (!protocol || protocol.deletedAt) {
    throw buildDietError(
      DietErrorCode.PROTOCOL_NOT_FOUND,
      DietMessageCode.PROTOCOL_NOT_FOUND,
      'Diet protocol not found.',
      404,
    );
  }

  if (protocol.nutritionistId !== nutritionistId) {
    throw buildDietError(
      DietErrorCode.FORBIDDEN_NOT_PROTOCOL_OWNER,
      DietMessageCode.FORBIDDEN_NOT_PROTOCOL_OWNER,
      'You do not own this protocol.',
      403,
    );
  }

  if (data.status && !dietProtocolStatusValues.includes(data.status)) {
    throw new AppError({
      httpStatus: 400,
      error: 'INVALID_STATUS',
      messageCode: 'validation.failed',
      message: `Invalid status: ${data.status}`,
    });
  }

  const updateData = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.description !== undefined) updateData.description = data.description;
  if (data.status !== undefined) updateData.status = data.status;
  if (data.startDate !== undefined) updateData.startDate = parseDateOnlyAsUtc(data.startDate);
  if (data.expirationDate !== undefined) updateData.expirationDate = parseDateOnlyAsUtc(data.expirationDate);
  if (data.dietType !== undefined) updateData.dietType = data.dietType;
  if (data.goalType !== undefined) updateData.goalType = data.goalType;
  if (data.tmbFormula !== undefined) updateData.tmbFormula = data.tmbFormula;
  if (data.tmbKcal !== undefined) updateData.tmbKcal = data.tmbKcal;
  if (data.activityLevel !== undefined) updateData.activityLevel = data.activityLevel;
  if (data.getKcal !== undefined) updateData.getKcal = data.getKcal;
  if (data.dailyCaloricTarget !== undefined) updateData.dailyCaloricTarget = data.dailyCaloricTarget;
  if (data.notes !== undefined) updateData.notes = data.notes;

  const updated = await db.dietProtocol.update({
    where: { id: protocolId },
    data: updateData,
    include: PROTOCOL_INCLUDE_BASE,
  });

  return normalizeProtocolDates(updated);
}

/**
 * Soft-delete a diet protocol.
 *
 * @param {object} db - Prisma client
 * @param {string} nutritionistUserId - User ID of the nutritionist
 * @param {string} protocolId - Protocol UUID
 * @returns {Promise<object>} Deleted protocol
 */
export async function deleteProtocol(db, nutritionistUserId, protocolId) {
  const nutritionistId = await resolveNutritionistId(db, nutritionistUserId);

  const protocol = await db.dietProtocol.findUnique({ where: { id: protocolId } });

  if (!protocol || protocol.deletedAt) {
    throw buildDietError(
      DietErrorCode.PROTOCOL_NOT_FOUND,
      DietMessageCode.PROTOCOL_NOT_FOUND,
      'Diet protocol not found.',
      404,
    );
  }

  if (protocol.nutritionistId !== nutritionistId) {
    throw buildDietError(
      DietErrorCode.FORBIDDEN_NOT_PROTOCOL_OWNER,
      DietMessageCode.FORBIDDEN_NOT_PROTOCOL_OWNER,
      'You do not own this protocol.',
      403,
    );
  }

  const deleted = await db.dietProtocol.update({
    where: { id: protocolId },
    data: { deletedAt: new Date() },
  });

  return normalizeProtocolDates(deleted);
}

/**
 * Get all diet protocols assigned to a patient (patient's view).
 *
 * @param {object} db - Prisma client
 * @param {string} userId - User ID of the patient
 * @param {{ status?: string }} filters
 * @returns {Promise<object[]>} List of protocols
 */
export async function getMyProtocols(db, userId, filters = {}) {
  if (filters.status && !dietProtocolStatusValues.includes(filters.status)) {
    throw new AppError({
      httpStatus: 400,
      error: 'INVALID_STATUS',
      messageCode: 'validation.failed',
      message: `Invalid status: ${filters.status}`,
    });
  }

  const where = {
    assigneeId: userId,
    deletedAt: null,
    status: filters.status || { in: ['active', 'completed'] },
  };

  const protocols = await db.dietProtocol.findMany({
    where,
    include: {
      nutritionist: {
        include: {
          user: {
            select: { id: true, firstName: true, lastName: true, avatarUrl: true },
          },
        },
      },
      meals: {
        where: { deletedAt: null },
        orderBy: { order: 'asc' },
        include: {
          foodItems: {
            where: { deletedAt: null },
            orderBy: { order: 'asc' },
          },
        },
      },
    },
    orderBy: { startDate: 'desc' },
  });

  return protocols.map((protocol) => {
    const { nutritionist, ...rest } = protocol;
    return {
      ...normalizeProtocolDates(rest),
      nutritionist: nutritionist?.user || null,
    };
  });
}
