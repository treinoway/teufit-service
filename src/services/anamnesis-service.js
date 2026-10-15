import { prisma } from '../db.js';
import emailHandler from '../config/email-handler.js';
import { AppError } from '../errors/app-error.js';
import { withDeadlockRetry } from '../helpers/db-retry.js';
import { lockAnamnesisForUpdate, lockAnamnesisResponseForUpdate } from '../helpers/row-locks.js';
import {
  AnamnesisErrorCode,
  AnamnesisMessageCode,
  questionTypesWithOptions,
  isQuestionVisible,
  toResponseStatus,
  AnamnesisFilledBy,
  AnamnesisResponseStatus,
} from '../constants/anamnesis.js';
import {
  fullAnamnesisInclude,
  findSectionOrThrow,
  findQuestionOrThrow,
  validateQuestionType,
  buildQuestionsCreateData,
  validateSectionIds,
  validateParentLink,
  normalizeChoiceAnswersForVisibility,
} from './anamnesis-shared.js';
import { assertStudentActiveOnPlan } from './platform-plan-service.js';

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Remap option IDs inside a condition JSONB when forking/copying an anamnesis.
 * Returns a new condition object with old option IDs replaced by new ones.
 * Returns null if the condition is null/undefined.
 *
 * @param {object|null} condition
 * @param {Map<string, string>} optionIdMap - old optionId → new optionId
 * @returns {object|null}
 */
function remapConditionOptionIds(condition, optionIdMap) {
  if (!condition) return null;

  if (condition.optionId !== undefined) {
    return {
      ...condition,
      optionId: optionIdMap.get(condition.optionId) ?? condition.optionId,
    };
  }

  if (Array.isArray(condition.optionIds)) {
    return {
      ...condition,
      optionIds: condition.optionIds.map((id) => optionIdMap.get(id) ?? id),
    };
  }

  return condition;
}

/**
 * Load the Trainer record for the given userId or throw 404.
 */
async function findTrainerOrThrow(userId, prismaClient = prisma) {
  const trainer = await prismaClient.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw new AppError({
      httpStatus: 404,
      error: AnamnesisErrorCode.TRAINER_PROFILE_MISSING,
      messageCode: AnamnesisMessageCode.TRAINER_PROFILE_MISSING,
      message: 'Trainer profile not found',
    });
  }

  return trainer;
}

/**
 * Load an Anamnesis by id (excluding soft-deleted). Throws 404 if missing.
 */
async function findAnamnesisOrThrow(anamnesisId) {
  const anamnesis = await prisma.anamnesis.findUnique({
    where: { id: anamnesisId },
  });

  if (!anamnesis || anamnesis.deletedAt) {
    throw new AppError({
      httpStatus: 404,
      error: AnamnesisErrorCode.ANAMNESIS_NOT_FOUND,
      messageCode: AnamnesisMessageCode.ANAMNESIS_NOT_FOUND,
      message: 'Anamnesis not found',
    });
  }

  return anamnesis;
}

/**
 * Assert the anamnesis has no linked students.
 * Throws 409 if any StudentAnamnesis record references this anamnesis.
 * Must be called before any structural mutation (add/update/delete section or question).
 */
async function assertAnamnesisNotLinked(anamnesisId) {
  const count = await prisma.studentAnamnesis.count({ where: { anamnesisId } });
  if (count > 0) {
    throw new AppError({
      httpStatus: 409,
      error: AnamnesisErrorCode.ANAMNESIS_HAS_STUDENT_LINKS,
      messageCode: AnamnesisMessageCode.ANAMNESIS_HAS_STUDENT_LINKS,
      message: 'This anamnesis is linked to students. Fork it first before editing.',
    });
  }
}

/**
 * Assert the trainer owns the anamnesis. Throws 403 for general anamneses
 * (no owner) and for anamneses owned by another trainer.
 */
function verifyAnamnesisOwnership(anamnesis, trainerId) {
  if (anamnesis.isGeneral) {
    throw new AppError({
      httpStatus: 403,
      error: AnamnesisErrorCode.FORBIDDEN_GENERAL_ANAMNESIS,
      messageCode: AnamnesisMessageCode.FORBIDDEN_GENERAL_ANAMNESIS,
      message: 'General anamneses cannot be modified',
    });
  }

  if (anamnesis.trainerId !== trainerId) {
    throw new AppError({
      httpStatus: 403,
      error: AnamnesisErrorCode.FORBIDDEN_NOT_ANAMNESIS_OWNER,
      messageCode: AnamnesisMessageCode.FORBIDDEN_NOT_ANAMNESIS_OWNER,
      message: 'You do not own this anamnesis',
    });
  }
}

/**
 * Verify the trainer-student link exists.
 * Returns the Trainer record.
 */
async function verifyTrainerStudentLink(trainerUserId, studentId, prismaClient = prisma) {
  const trainer = await findTrainerOrThrow(trainerUserId, prismaClient);

  const link = await prismaClient.trainerStudent.findUnique({
    where: { trainerId_studentId: { trainerId: trainer.id, studentId } },
  });

  if (!link) {
    throw new AppError({
      httpStatus: 404,
      error: AnamnesisErrorCode.STUDENT_NOT_FOUND,
      messageCode: AnamnesisMessageCode.STUDENT_NOT_FOUND,
      message: 'Student not found or not assigned to you',
    });
  }

  return trainer;
}

// ─── Anamnesis CRUD ───────────────────────────────────────────────────────────

/**
 * Create a new anamnesis (with optional nested sections/questions/options)
 * inside a single transaction.
 *
 * @param {string} userId - The authenticated trainer's user ID
 * @param {object} data - { title, description, sections }
 * @returns {Promise<object>} The created anamnesis with full nested structure
 */
export async function createAnamnesis(userId, data) {
  const trainer = await findTrainerOrThrow(userId);

  const anamnesis = await prisma.$transaction(async (tx) => {
    const created = await tx.anamnesis.create({
      data: {
        trainerId: trainer.id,
        title: data.title,
        description: data.description ?? null,
        isGeneral: false,
        sections: data.sections?.length
          ? {
              create: data.sections.map((section, sectionIndex) => ({
                title: section.title,
                description: section.description ?? null,
                order: section.order ?? sectionIndex,
                questions: section.questions?.length
                  ? { create: buildQuestionsCreateData(section.questions) }
                  : undefined,
              })),
            }
          : undefined,
      },
      include: fullAnamnesisInclude,
    });

    return created;
  });

  return anamnesis;
}

/**
 * List anamneses visible to the trainer: their own private ones + all general ones.
 *
 * @param {string} userId
 * @returns {Promise<object[]>}
 */
export async function listAnamneses(userId) {
  const trainer = await findTrainerOrThrow(userId);

  const anamneses = await prisma.anamnesis.findMany({
    where: {
      deletedAt: null,
      OR: [{ trainerId: trainer.id }, { isGeneral: true }],
    },
    orderBy: [{ isGeneral: 'desc' }, { createdAt: 'desc' }],
    include: {
      sections: {
        where: { deletedAt: null },
        orderBy: { order: 'asc' },
        select: { id: true, title: true, order: true },
      },
    },
  });

  return anamneses;
}

/**
 * Get full detail of an anamnesis (accessible if it's general or owned by trainer).
 *
 * @param {string} userId
 * @param {string} anamnesisId
 * @returns {Promise<object>}
 */
export async function getAnamnesisById(userId, anamnesisId) {
  const trainer = await findTrainerOrThrow(userId);
  const anamnesis = await findAnamnesisOrThrow(anamnesisId);

  if (!anamnesis.isGeneral && anamnesis.trainerId !== trainer.id) {
    throw new AppError({
      httpStatus: 403,
      error: AnamnesisErrorCode.FORBIDDEN_NOT_ANAMNESIS_OWNER,
      messageCode: AnamnesisMessageCode.FORBIDDEN_NOT_ANAMNESIS_OWNER,
      message: 'You do not have access to this anamnesis',
    });
  }

  return prisma.anamnesis.findUnique({
    where: { id: anamnesisId },
    include: fullAnamnesisInclude,
  });
}

/**
 * Update anamnesis title/description. Blocks modification of general anamneses.
 *
 * @param {string} userId
 * @param {string} anamnesisId
 * @param {object} data - { title, description }
 * @returns {Promise<object>}
 */
export async function updateAnamnesis(userId, anamnesisId, data) {
  const trainer = await findTrainerOrThrow(userId);
  const anamnesis = await findAnamnesisOrThrow(anamnesisId);

  verifyAnamnesisOwnership(anamnesis, trainer.id);

  const updated = await prisma.anamnesis.update({
    where: { id: anamnesisId },
    data: {
      ...(data.title !== undefined && { title: data.title }),
      ...(data.description !== undefined && { description: data.description }),
    },
    include: fullAnamnesisInclude,
  });

  return updated;
}

/**
 * Soft-delete an anamnesis with manual cascade to sections and questions.
 *
 * @param {string} userId
 * @param {string} anamnesisId
 * @returns {Promise<object>}
 */
export async function deleteAnamnesis(userId, anamnesisId) {
  const trainer = await findTrainerOrThrow(userId);
  const anamnesis = await findAnamnesisOrThrow(anamnesisId);

  verifyAnamnesisOwnership(anamnesis, trainer.id);
  await assertAnamnesisNotLinked(anamnesisId);

  const now = new Date();

  await withDeadlockRetry(() => prisma.$transaction(async (tx) => {
    await lockAnamnesisForUpdate(tx, anamnesisId);

    const sections = await tx.anamnesisSection.findMany({
      where: { anamnesisId, deletedAt: null },
      select: { id: true },
    });

    if (sections.length > 0) {
      const sectionIds = sections.map((s) => s.id);

      await tx.anamnesisQuestion.updateMany({
        where: { sectionId: { in: sectionIds }, deletedAt: null },
        data: { deletedAt: now },
      });

      await tx.anamnesisSection.updateMany({
        where: { id: { in: sectionIds } },
        data: { deletedAt: now },
      });
    }

    await tx.anamnesis.update({
      where: { id: anamnesisId },
      data: { deletedAt: now },
    });
  }));

  return { id: anamnesisId, deletedAt: now };
}

// ─── Section CRUD ─────────────────────────────────────────────────────────────

/**
 * Add a section (with optional questions/options) to an anamnesis.
 *
 * @param {string} userId
 * @param {string} anamnesisId
 * @param {object} data - { title, description, order, questions }
 * @returns {Promise<object>}
 */
export async function addSection(userId, anamnesisId, data) {
  const trainer = await findTrainerOrThrow(userId);
  const anamnesis = await findAnamnesisOrThrow(anamnesisId);

  verifyAnamnesisOwnership(anamnesis, trainer.id);
  await assertAnamnesisNotLinked(anamnesisId);

  const section = await prisma.anamnesisSection.create({
    data: {
      anamnesisId,
      title: data.title,
      description: data.description ?? null,
      order: data.order ?? 0,
      questions: data.questions?.length
        ? { create: buildQuestionsCreateData(data.questions) }
        : undefined,
    },
    include: {
      questions: {
        where: { deletedAt: null },
        orderBy: { order: 'asc' },
        include: { options: { orderBy: { order: 'asc' } } },
      },
    },
  });

  return section;
}

/**
 * Update section title/description/order.
 *
 * @param {string} userId
 * @param {string} anamnesisId
 * @param {string} sectionId
 * @param {object} data - { title, description, order }
 * @returns {Promise<object>}
 */
export async function updateSection(userId, anamnesisId, sectionId, data) {
  const trainer = await findTrainerOrThrow(userId);
  const anamnesis = await findAnamnesisOrThrow(anamnesisId);

  verifyAnamnesisOwnership(anamnesis, trainer.id);
  await assertAnamnesisNotLinked(anamnesisId);
  await findSectionOrThrow(anamnesisId, sectionId);

  const updated = await prisma.anamnesisSection.update({
    where: { id: sectionId },
    data: {
      ...(data.title !== undefined && { title: data.title }),
      ...(data.description !== undefined && { description: data.description }),
      ...(data.order !== undefined && { order: data.order }),
    },
    include: {
      questions: {
        where: { deletedAt: null },
        orderBy: { order: 'asc' },
        include: { options: { orderBy: { order: 'asc' } } },
      },
    },
  });

  return updated;
}

/**
 * Soft-delete a section and cascade to its questions.
 *
 * @param {string} userId
 * @param {string} anamnesisId
 * @param {string} sectionId
 * @returns {Promise<object>}
 */
export async function deleteSection(userId, anamnesisId, sectionId) {
  const trainer = await findTrainerOrThrow(userId);
  const anamnesis = await findAnamnesisOrThrow(anamnesisId);

  verifyAnamnesisOwnership(anamnesis, trainer.id);
  await assertAnamnesisNotLinked(anamnesisId);
  await findSectionOrThrow(anamnesisId, sectionId);

  const now = new Date();

  await withDeadlockRetry(() => prisma.$transaction(async (tx) => {
    await lockAnamnesisForUpdate(tx, anamnesisId);

    await tx.anamnesisQuestion.updateMany({
      where: { sectionId, deletedAt: null },
      data: { deletedAt: now },
    });

    await tx.anamnesisSection.update({
      where: { id: sectionId },
      data: { deletedAt: now },
    });
  }));

  return { id: sectionId, deletedAt: now };
}

/**
 * Reorder sections by providing an ordered array of section IDs.
 * Validates that all IDs belong to the anamnesis before updating.
 * Each section receives an `order` value equal to its index in the array.
 *
 * @param {string} userId
 * @param {string} anamnesisId
 * @param {string[]} orderedIds - Section IDs in the desired order
 * @returns {Promise<object[]>}
 */
export async function reorderSections(userId, anamnesisId, orderedIds) {
  const trainer = await findTrainerOrThrow(userId);
  const anamnesis = await findAnamnesisOrThrow(anamnesisId);

  verifyAnamnesisOwnership(anamnesis, trainer.id);
  await assertAnamnesisNotLinked(anamnesisId);
  await validateSectionIds(anamnesisId, orderedIds);

  const orderById = new Map(orderedIds.map((id, index) => [id, index]));
  const sortedIds = [...orderedIds].sort((a, b) => (a < b ? -1 : 1));

  await withDeadlockRetry(() => prisma.$transaction(async (tx) => {
    await lockAnamnesisForUpdate(tx, anamnesisId);
    for (const id of sortedIds) {
      await tx.anamnesisSection.update({
        where: { id },
        data: { order: orderById.get(id) },
      });
    }
  }));

  const sections = await prisma.anamnesisSection.findMany({
    where: { anamnesisId, deletedAt: null },
    orderBy: { order: 'asc' },
    include: {
      questions: {
        where: { deletedAt: null },
        orderBy: { order: 'asc' },
        include: { options: { orderBy: { order: 'asc' } } },
      },
    },
  });

  return sections;
}

// ─── Question CRUD ────────────────────────────────────────────────────────────

/**
 * Add a question (with optional options) to a section.
 *
 * @param {string} userId
 * @param {string} anamnesisId
 * @param {string} sectionId
 * @param {object} data - { text, type, required, order, config, options, parentQuestionId, condition }
 * @returns {Promise<object>}
 */
export async function addQuestion(userId, anamnesisId, sectionId, data) {
  const trainer = await findTrainerOrThrow(userId);
  const anamnesis = await findAnamnesisOrThrow(anamnesisId);

  verifyAnamnesisOwnership(anamnesis, trainer.id);
  await assertAnamnesisNotLinked(anamnesisId);
  await findSectionOrThrow(anamnesisId, sectionId);
  validateQuestionType(data.type);

  if (data.parentQuestionId) {
    await validateParentLink({
      parentId: data.parentQuestionId,
      childSectionId: sectionId,
      condition: data.condition,
    });
  }

  const question = await prisma.anamnesisQuestion.create({
    data: {
      sectionId,
      text: data.text,
      type: data.type,
      required: data.required ?? false,
      order: data.order ?? 0,
      config: data.config ?? null,
      parentQuestionId: data.parentQuestionId ?? null,
      condition: data.condition ?? null,
      options: questionTypesWithOptions.includes(data.type) && data.options?.length
        ? {
            create: data.options.map((opt, index) => ({
              text: opt.text,
              order: opt.order ?? index,
            })),
          }
        : undefined,
    },
    include: {
      options: { orderBy: { order: 'asc' } },
      dependentQuestions: { where: { deletedAt: null }, select: { id: true } },
    },
  });

  return question;
}

/**
 * Update a question. If options are provided, they completely replace existing options.
 *
 * @param {string} userId
 * @param {string} anamnesisId
 * @param {string} sectionId
 * @param {string} questionId
 * @param {object} data - { text, type, required, order, config, options, parentQuestionId, condition }
 * @returns {Promise<object>}
 */
export async function updateQuestion(userId, anamnesisId, sectionId, questionId, data) {
  const trainer = await findTrainerOrThrow(userId);
  const anamnesis = await findAnamnesisOrThrow(anamnesisId);

  verifyAnamnesisOwnership(anamnesis, trainer.id);
  await assertAnamnesisNotLinked(anamnesisId);
  await findSectionOrThrow(anamnesisId, sectionId);
  const existingQuestion = await findQuestionOrThrow(sectionId, questionId);

  if (data.type !== undefined) {
    validateQuestionType(data.type, { existingType: existingQuestion.type });
  }

  // Block type change if the question has dependent (child) questions
  if (data.type !== undefined && data.type !== existingQuestion.type) {
    const dependentCount = await prisma.anamnesisQuestion.count({
      where: { parentQuestionId: questionId, deletedAt: null },
    });
    if (dependentCount > 0) {
      throw new AppError({
        httpStatus: 409,
        error: AnamnesisErrorCode.PARENT_TYPE_LOCKED,
        messageCode: AnamnesisMessageCode.PARENT_TYPE_LOCKED,
        message: 'Cannot change the type of a question that has conditional child questions. Detach or delete the dependent questions first.',
      });
    }
  }

  // Block removing options that are referenced by child condition
  if (data.options !== undefined) {
    const childrenWithConditions = await prisma.anamnesisQuestion.findMany({
      where: { parentQuestionId: questionId, deletedAt: null, condition: { not: null } },
      select: { id: true, condition: true },
    });

    if (childrenWithConditions.length > 0) {
      // We compare by text since incoming options don't have IDs yet (they're being replaced).
      // Any referenced optionId whose text is not present in the new options list is being removed.
      const existingOptions = await prisma.anamnesisQuestionOption.findMany({
        where: { questionId },
        select: { id: true, text: true },
      });

      const existingOptionsByText = new Map(existingOptions.map((o) => [o.text, o.id]));
      const keptOptionIds = new Set(
        data.options
          .map((o) => existingOptionsByText.get(o.text))
          .filter(Boolean),
      );

      for (const child of childrenWithConditions) {
        const condition = child.condition;
        if (!condition) continue;

        const referencedIds = condition.optionId
          ? [condition.optionId]
          : (condition.optionIds ?? []);

        const removedReference = referencedIds.find((id) => !keptOptionIds.has(id));
        if (removedReference) {
          throw new AppError({
            httpStatus: 409,
            error: AnamnesisErrorCode.CONDITION_REFERENCES_REMOVED_OPTION,
            messageCode: AnamnesisMessageCode.CONDITION_REFERENCES_REMOVED_OPTION,
            message: 'Cannot remove an option that is referenced by a conditional child question.',
          });
        }
      }
    }
  }

  const effectiveType = data.type ?? existingQuestion.type;

  // Validate parent link if parentQuestionId or condition is being set
  const newParentId = data.parentQuestionId !== undefined
    ? data.parentQuestionId
    : existingQuestion.parentQuestionId;
  const newCondition = data.condition !== undefined
    ? data.condition
    : existingQuestion.condition;

  if (newParentId) {
    await validateParentLink({
      parentId: newParentId,
      childSectionId: sectionId,
      condition: newCondition,
    });
  }

  const updated = await prisma.$transaction(async (tx) => {
    if (data.options !== undefined) {
      await tx.anamnesisQuestionOption.deleteMany({ where: { questionId } });

      if (questionTypesWithOptions.includes(effectiveType) && data.options.length > 0) {
        await tx.anamnesisQuestionOption.createMany({
          data: data.options.map((opt, index) => ({
            questionId,
            text: opt.text,
            order: opt.order ?? index,
          })),
        });
      }
    }

    return tx.anamnesisQuestion.update({
      where: { id: questionId },
      data: {
        ...(data.text !== undefined && { text: data.text }),
        ...(data.type !== undefined && { type: data.type }),
        ...(data.required !== undefined && { required: data.required }),
        ...(data.order !== undefined && { order: data.order }),
        ...(data.config !== undefined && { config: data.config }),
        ...(data.parentQuestionId !== undefined && { parentQuestionId: data.parentQuestionId }),
        ...(data.condition !== undefined && { condition: data.condition }),
      },
      include: {
        options: { orderBy: { order: 'asc' } },
        dependentQuestions: { where: { deletedAt: null }, select: { id: true } },
      },
    });
  });

  return updated;
}

/**
 * Soft-delete a question.
 *
 * @param {string} userId
 * @param {string} anamnesisId
 * @param {string} sectionId
 * @param {string} questionId
 * @returns {Promise<object>}
 */
export async function deleteQuestion(userId, anamnesisId, sectionId, questionId) {
  const trainer = await findTrainerOrThrow(userId);
  const anamnesis = await findAnamnesisOrThrow(anamnesisId);

  verifyAnamnesisOwnership(anamnesis, trainer.id);
  await assertAnamnesisNotLinked(anamnesisId);
  await findSectionOrThrow(anamnesisId, sectionId);
  await findQuestionOrThrow(sectionId, questionId);

  const now = new Date();

  await prisma.anamnesisQuestion.update({
    where: { id: questionId },
    data: { deletedAt: now },
  });

  return { id: questionId, deletedAt: now };
}

// ─── Student linking ──────────────────────────────────────────────────────────

/**
 * Link an anamnesis to a student. The trainer must own the student relationship
 * and have access to the anamnesis (own it or it's general).
 *
 * @param {string} userId - Trainer's user ID
 * @param {string} studentId - Student's user ID
 * @param {object} data - { anamnesisId }
 * @returns {Promise<object>}
 */
export async function linkAnamnesisToStudent(userId, studentId, data) {
  const trainer = await verifyTrainerStudentLink(userId, studentId);
  await assertStudentActiveOnPlan(prisma, trainer.id, studentId);
  const anamnesis = await findAnamnesisOrThrow(data.anamnesisId);

  if (!anamnesis.isGeneral && anamnesis.trainerId !== trainer.id) {
    throw new AppError({
      httpStatus: 403,
      error: AnamnesisErrorCode.FORBIDDEN_NOT_ANAMNESIS_OWNER,
      messageCode: AnamnesisMessageCode.FORBIDDEN_NOT_ANAMNESIS_OWNER,
      message: 'You do not have access to this anamnesis',
    });
  }

  try {
    const link = await prisma.studentAnamnesis.create({
      data: {
        anamnesisId: data.anamnesisId,
        studentId,
        trainerId: trainer.id,
      },
      include: {
        anamnesis: { select: { id: true, title: true, isGeneral: true } },
      },
    });

    return link;
  } catch (error) {
    if (error.code === 'P2002') {
      throw new AppError({
        httpStatus: 409,
        error: AnamnesisErrorCode.ANAMNESIS_ALREADY_LINKED,
        messageCode: AnamnesisMessageCode.ANAMNESIS_ALREADY_LINKED,
        message: 'This anamnesis is already linked to the student',
      });
    }
    throw error;
  }
}

/**
 * List all anamneses linked to a student by this trainer, each with a summary of the
 * student's response (never its answers) and whether this trainer may still finalize it.
 *
 * @param {string} userId - Trainer's user ID
 * @param {string} studentId
 * @param {object} [prismaClient]
 * @returns {Promise<object[]>}
 */
export async function listStudentAnamneses(userId, studentId, prismaClient = prisma) {
  const trainer = await verifyTrainerStudentLink(userId, studentId, prismaClient);

  const links = await prismaClient.studentAnamnesis.findMany({
    where: { studentId, trainerId: trainer.id },
    orderBy: { createdAt: 'desc' },
    include: {
      anamnesis: {
        select: {
          id: true,
          title: true,
          description: true,
          isGeneral: true,
          createdAt: true,
          sections: {
            where: { deletedAt: null },
            select: { id: true, title: true, order: true },
            orderBy: { order: 'asc' },
          },
        },
      },
    },
  });

  return attachResponseSummaries(links, studentId, prismaClient, { trainerUserId: userId });
}

/**
 * Unlink an anamnesis from a student (hard delete of the junction record).
 *
 * @param {string} userId - Trainer's user ID
 * @param {string} studentId
 * @param {string} anamnesisId
 * @returns {Promise<object>}
 */
export async function unlinkAnamnesisFromStudent(userId, studentId, anamnesisId) {
  const trainer = await verifyTrainerStudentLink(userId, studentId);
  await assertStudentActiveOnPlan(prisma, trainer.id, studentId);

  const link = await prisma.studentAnamnesis.findUnique({
    where: {
      anamnesisId_studentId_trainerId: {
        anamnesisId,
        studentId,
        trainerId: trainer.id,
      },
    },
  });

  if (!link) {
    throw new AppError({
      httpStatus: 404,
      error: AnamnesisErrorCode.ANAMNESIS_NOT_FOUND,
      messageCode: AnamnesisMessageCode.ANAMNESIS_NOT_FOUND,
      message: 'Anamnesis link not found for this student',
    });
  }

  await prisma.studentAnamnesis.delete({
    where: {
      anamnesisId_studentId_trainerId: {
        anamnesisId,
        studentId,
        trainerId: trainer.id,
      },
    },
  });

  return { id: link.id };
}

// ─── Student view ─────────────────────────────────────────────────────────────

/**
 * Compact, list-friendly view of a response. Never carries answers or the filler's user id.
 *
 * @param {{ submittedAt: Date|null, filledByRole: string, studentConfirmedAt: Date|null,
 *   updatedAt: Date|null, _count: { answers: number } }} response
 * @returns {object}
 */
function toResponseSummary(response) {
  return {
    status: toResponseStatus(response),
    filledBy: response.filledByRole,
    submittedAt: response.submittedAt,
    answeredCount: response._count.answers,
    updatedAt: response.updatedAt,
  };
}

/**
 * Attach a compact `response` summary (or null) to each student-anamnesis link.
 * Uses a single query for all links — no N+1.
 *
 * When `trainerUserId` is given (trainer view) each link also gets `canFill`, computed in
 * memory from the same rows with the exact rule of the fill guard (getTrainerFinalizeBlock).
 *
 * @param {object[]} links - StudentAnamnesis rows
 * @param {string} studentId
 * @param {object} [prismaClient]
 * @param {{ trainerUserId?: string }} [options] - `trainerUserId` is the trainer's USER id
 * @returns {Promise<object[]>}
 */
async function attachResponseSummaries(links, studentId, prismaClient = prisma, { trainerUserId } = {}) {
  if (links.length === 0) return links;

  const responses = await prismaClient.anamnesisResponse.findMany({
    where: { studentId, anamnesisId: { in: links.map((link) => link.anamnesisId) } },
    select: {
      anamnesisId: true,
      submittedAt: true,
      filledByRole: true,
      filledByUserId: true,
      studentConfirmedAt: true,
      updatedAt: true,
      _count: { select: { answers: true } },
    },
  });

  const responseByAnamnesisId = new Map(responses.map((response) => [response.anamnesisId, response]));

  return links.map((link) => {
    const response = responseByAnamnesisId.get(link.anamnesisId) ?? null;
    const linkWithSummary = { ...link, response: response ? toResponseSummary(response) : null };

    if (trainerUserId === undefined) return linkWithSummary;

    return { ...linkWithSummary, canFill: getTrainerFinalizeBlock(response, trainerUserId) === null };
  });
}

// Shape of a student-facing link (list and detail): full anamnesis structure plus the trainer.
const myAnamnesisLinkInclude = {
  anamnesis: {
    select: {
      id: true,
      title: true,
      description: true,
      isGeneral: true,
      createdAt: true,
      // parentQuestionId and condition are returned via default field selection
      ...fullAnamnesisInclude,
    },
  },
  trainer: {
    select: {
      id: true,
      user: { select: { firstName: true, lastName: true, avatarUrl: true } },
    },
  },
};

/**
 * Attach `trainerLinkActive` to each student-anamnesis link: true while a TrainerStudent row
 * exists for (link.trainerId, studentId), i.e. the trainer still coaches the student. The
 * trainer-student unlink hard-deletes that row; `activeOnPlan` is deliberately ignored — it is
 * the trainer's billing seat quota, not the coaching relationship.
 * Uses a single query for all links — no N+1.
 *
 * @param {object[]} links - StudentAnamnesis rows
 * @param {string} studentId
 * @param {object} [prismaClient]
 * @returns {Promise<object[]>}
 */
async function attachTrainerLinkActive(links, studentId, prismaClient = prisma) {
  if (links.length === 0) return links;

  const activeTrainerLinks = await prismaClient.trainerStudent.findMany({
    where: { studentId, trainerId: { in: [...new Set(links.map((link) => link.trainerId))] } },
    select: { trainerId: true },
  });
  const activeTrainerIds = new Set(activeTrainerLinks.map((trainerLink) => trainerLink.trainerId));

  return links.map((link) => ({ ...link, trainerLinkActive: activeTrainerIds.has(link.trainerId) }));
}

/**
 * Get all anamneses linked to the authenticated student.
 *
 * @param {string} userId - Student's user ID
 * @param {object} [prismaClient]
 * @returns {Promise<object[]>}
 */
export async function getMyAnamneses(userId, prismaClient = prisma) {
  const links = await prismaClient.studentAnamnesis.findMany({
    where: { studentId: userId },
    orderBy: { createdAt: 'desc' },
    include: myAnamnesisLinkInclude,
  });

  const linksWithTrainerStatus = await attachTrainerLinkActive(links, userId, prismaClient);
  return attachResponseSummaries(linksWithTrainerStatus, userId, prismaClient);
}

/**
 * Get one anamnesis linked to the authenticated student, with its full structure and the
 * full response (answers included; draft, awaiting confirmation or submitted), or null.
 * When several trainers linked the same anamnesis, the most recent link wins (the response
 * itself is unique per anamnesis and student, so it is the same for every link).
 *
 * @param {string} userId - Student's user ID
 * @param {string} anamnesisId
 * @param {object} [prismaClient]
 * @returns {Promise<object>}
 */
export async function getMyAnamnesisDetail(userId, anamnesisId, prismaClient = prisma) {
  const link = await prismaClient.studentAnamnesis.findFirst({
    where: { studentId: userId, anamnesisId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    include: myAnamnesisLinkInclude,
  });

  if (!link) {
    throw new AppError({
      httpStatus: 404,
      error: AnamnesisErrorCode.ANAMNESIS_NOT_LINKED_TO_STUDENT,
      messageCode: AnamnesisMessageCode.ANAMNESIS_NOT_LINKED_TO_STUDENT,
      message: 'This anamnesis is not linked to your account',
    });
  }

  const [[linkWithTrainerStatus], response] = await Promise.all([
    attachTrainerLinkActive([link], userId, prismaClient),
    prismaClient.anamnesisResponse.findUnique({
      where: { anamnesisId_studentId: { anamnesisId, studentId: userId } },
      include: { answers: true },
    }),
  ]);

  return { ...linkWithTrainerStatus, response: response ? withResponseStatus(response) : null };
}

/**
 * Email the student that a trainer assigned them an anamnesis. Meant to run after the link
 * response was sent: throws on delivery failure so the caller can log it, never retries.
 * Skips silently when the student has no deliverable email (deleted account, no email).
 *
 * @param {{ trainerId: string, studentId: string, anamnesisTitle: string }} assignment
 * @param {object} [prismaClient]
 * @param {{ emailSender?: object }} [deps]
 * @returns {Promise<void>}
 */
export async function notifyStudentAnamnesisAssigned(
  { trainerId, studentId, anamnesisTitle },
  prismaClient = prisma,
  { emailSender = emailHandler } = {},
) {
  const [student, trainer] = await Promise.all([
    prismaClient.user.findUnique({
      where: { id: studentId },
      select: { email: true, firstName: true, deletedAt: true },
    }),
    prismaClient.trainer.findUnique({
      where: { id: trainerId },
      select: { user: { select: { firstName: true, lastName: true } } },
    }),
  ]);

  if (!student?.email || student.deletedAt) return;

  const trainerName = `${trainer?.user?.firstName ?? ''} ${trainer?.user?.lastName ?? ''}`.trim();

  // The Resend SDK returns { data, error } instead of throwing.
  const emailResponse = await emailSender.sendAnamnesisAssignedEmail({
    to: student.email,
    studentName: student.firstName,
    trainerName,
    anamnesisTitle,
  });
  if (emailResponse?.error) {
    // Only the provider's error name: its message may echo the recipient address.
    throw new Error(`Anamnesis assigned email rejected by provider: ${emailResponse.error.name ?? 'unknown_error'}`);
  }
}

// ─── Versioning ───────────────────────────────────────────────────────────────

/**
 * Fork an anamnesis into a new version.
 * Creates a deep copy of all non-deleted sections, questions, and options.
 * Sets version = source.version + 1 and parentId = source.id.
 *
 * @param {string} userId - Trainer's user ID
 * @param {string} anamnesisId - The anamnesis to fork
 * @returns {Promise<object>} The newly forked anamnesis with full nested structure
 */
export async function forkAnamnesis(userId, anamnesisId) {
  const trainer = await findTrainerOrThrow(userId);
  const source = await findAnamnesisOrThrow(anamnesisId);

  verifyAnamnesisOwnership(source, trainer.id);

  const sourceWithContent = await prisma.anamnesis.findUnique({
    where: { id: anamnesisId },
    include: {
      sections: {
        where: { deletedAt: null },
        orderBy: { order: 'asc' },
        include: {
          questions: {
            where: { deletedAt: null },
            orderBy: { order: 'asc' },
            include: { options: { orderBy: { order: 'asc' } } },
          },
        },
      },
    },
  });

  const forked = await prisma.$transaction(async (tx) => {
    const newAnamnesis = await tx.anamnesis.create({
      data: {
        trainerId: source.trainerId,
        title: source.title,
        description: source.description,
        isGeneral: false,
        version: source.version + 1,
        parentId: source.id,
      },
    });

    // Two-pass build: first pass creates all questions and options, recording ID maps.
    // Second pass remaps parentQuestionId and option IDs inside condition JSONB.
    const questionIdMap = new Map(); // oldQuestionId → newQuestionId
    const optionIdMap = new Map();   // oldOptionId → newOptionId

    for (const section of sourceWithContent.sections) {
      const newSection = await tx.anamnesisSection.create({
        data: {
          anamnesisId: newAnamnesis.id,
          title: section.title,
          description: section.description,
          order: section.order,
        },
      });

      for (const question of section.questions) {
        const newQuestion = await tx.anamnesisQuestion.create({
          data: {
            sectionId: newSection.id,
            text: question.text,
            type: question.type,
            required: question.required,
            order: question.order,
            config: question.config,
            // parentQuestionId and condition are remapped in second pass
          },
        });

        questionIdMap.set(question.id, newQuestion.id);

        if (question.options.length > 0) {
          for (const opt of question.options) {
            const newOpt = await tx.anamnesisQuestionOption.create({
              data: {
                questionId: newQuestion.id,
                text: opt.text,
                order: opt.order,
              },
            });
            optionIdMap.set(opt.id, newOpt.id);
          }
        }
      }
    }

    // Second pass: remap parentQuestionId and option IDs inside condition
    for (const section of sourceWithContent.sections) {
      for (const question of section.questions) {
        if (!question.parentQuestionId) continue;

        const newQuestionId = questionIdMap.get(question.id);
        const newParentId = questionIdMap.get(question.parentQuestionId);
        const remappedCondition = remapConditionOptionIds(question.condition, optionIdMap);

        await tx.anamnesisQuestion.update({
          where: { id: newQuestionId },
          data: {
            parentQuestionId: newParentId ?? null,
            condition: remappedCondition,
          },
        });
      }
    }

    return tx.anamnesis.findUnique({
      where: { id: newAnamnesis.id },
      include: fullAnamnesisInclude,
    });
  });

  return forked;
}

/**
 * Copy an anamnesis into a new independent private copy owned by the trainer.
 * Works for public anamneses (isGeneral: true) and the trainer's own private ones.
 * Unlike forkAnamnesis, the copy starts fresh: parentId = null, version = 1.
 *
 * @param {string} userId - Trainer's user ID
 * @param {string} anamnesisId - The anamnesis to copy
 * @returns {Promise<object>} The newly copied anamnesis with full nested structure
 */
export async function copyAnamnesis(userId, anamnesisId) {
  const trainer = await findTrainerOrThrow(userId);
  const source = await findAnamnesisOrThrow(anamnesisId);

  if (!source.isGeneral && source.trainerId !== trainer.id) {
    throw new AppError({
      httpStatus: 403,
      error: AnamnesisErrorCode.FORBIDDEN_NOT_ANAMNESIS_OWNER,
      messageCode: AnamnesisMessageCode.FORBIDDEN_NOT_ANAMNESIS_OWNER,
      message: 'You do not have access to this anamnesis',
    });
  }

  const sourceWithContent = await prisma.anamnesis.findUnique({
    where: { id: anamnesisId },
    include: {
      sections: {
        where: { deletedAt: null },
        orderBy: { order: 'asc' },
        include: {
          questions: {
            where: { deletedAt: null },
            orderBy: { order: 'asc' },
            include: { options: { orderBy: { order: 'asc' } } },
          },
        },
      },
    },
  });

  const copied = await prisma.$transaction(async (tx) => {
    const newAnamnesis = await tx.anamnesis.create({
      data: {
        trainerId: trainer.id,
        title: source.title,
        description: source.description,
        isGeneral: false,
        version: 1,
        parentId: null,
      },
    });

    // Two-pass build: first pass creates all questions and options, recording ID maps.
    // Second pass remaps parentQuestionId and option IDs inside condition JSONB.
    const questionIdMap = new Map(); // oldQuestionId → newQuestionId
    const optionIdMap = new Map();   // oldOptionId → newOptionId

    for (const section of sourceWithContent.sections) {
      const newSection = await tx.anamnesisSection.create({
        data: {
          anamnesisId: newAnamnesis.id,
          title: section.title,
          description: section.description,
          order: section.order,
        },
      });

      for (const question of section.questions) {
        const newQuestion = await tx.anamnesisQuestion.create({
          data: {
            sectionId: newSection.id,
            text: question.text,
            type: question.type,
            required: question.required,
            order: question.order,
            config: question.config,
            // parentQuestionId and condition are remapped in second pass
          },
        });

        questionIdMap.set(question.id, newQuestion.id);

        if (question.options.length > 0) {
          for (const opt of question.options) {
            const newOpt = await tx.anamnesisQuestionOption.create({
              data: {
                questionId: newQuestion.id,
                text: opt.text,
                order: opt.order,
              },
            });
            optionIdMap.set(opt.id, newOpt.id);
          }
        }
      }
    }

    // Second pass: remap parentQuestionId and option IDs inside condition
    for (const section of sourceWithContent.sections) {
      for (const question of section.questions) {
        if (!question.parentQuestionId) continue;

        const newQuestionId = questionIdMap.get(question.id);
        const newParentId = questionIdMap.get(question.parentQuestionId);
        const remappedCondition = remapConditionOptionIds(question.condition, optionIdMap);

        await tx.anamnesisQuestion.update({
          where: { id: newQuestionId },
          data: {
            parentQuestionId: newParentId ?? null,
            condition: remappedCondition,
          },
        });
      }
    }

    return tx.anamnesis.findUnique({
      where: { id: newAnamnesis.id },
      include: fullAnamnesisInclude,
    });
  });

  return copied;
}

// ─── Student responses ────────────────────────────────────────────────────────

const UNIQUE_CONSTRAINT_VIOLATION_CODE = 'P2002';

/**
 * Verify the anamnesis is linked to the student.
 * Throws 404 ANAMNESIS_NOT_LINKED_TO_STUDENT otherwise.
 *
 * @param {string} studentId
 * @param {string} anamnesisId
 * @param {object} [prismaClient]
 */
async function assertAnamnesisLinkedToStudent(studentId, anamnesisId, prismaClient = prisma) {
  const link = await prismaClient.studentAnamnesis.findFirst({
    where: { studentId, anamnesisId },
  });

  if (!link) {
    throw new AppError({
      httpStatus: 404,
      error: AnamnesisErrorCode.ANAMNESIS_NOT_LINKED_TO_STUDENT,
      messageCode: AnamnesisMessageCode.ANAMNESIS_NOT_LINKED_TO_STUDENT,
      message: 'This anamnesis is not linked to your account',
    });
  }
}

/**
 * Add the derived `status` and the public `filledBy` (author role) to a response row.
 *
 * @param {{ submittedAt: Date|null, filledByRole: string, studentConfirmedAt: Date|null }} response
 * @returns {object}
 */
function withResponseStatus(response) {
  return { ...response, status: toResponseStatus(response), filledBy: response.filledByRole };
}

/**
 * An answer is "empty" (and therefore clears the stored answer on draft save)
 * when it is null/undefined, a blank string, or an empty array.
 *
 * @param {*} value
 * @returns {boolean}
 */
function isEmptyAnswerValue(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function assertNoDuplicateQuestionIds(answers) {
  const seenQuestionIds = new Set();
  const duplicatedQuestionIds = new Set();

  for (const { questionId } of answers) {
    if (seenQuestionIds.has(questionId)) duplicatedQuestionIds.add(questionId);
    seenQuestionIds.add(questionId);
  }

  if (duplicatedQuestionIds.size > 0) {
    throw new AppError({
      httpStatus: 400,
      error: 'VALIDATION_ERROR',
      messageCode: 'validation.failed',
      message: 'Duplicate questionId in answers',
      details: [...duplicatedQuestionIds].map((questionId) => ({
        questionId,
        message: 'Duplicate questionId in answers',
      })),
    });
  }
}

/**
 * Verify every answered question belongs to the anamnesis (non-deleted question
 * in a non-deleted section). Throws 404 ANAMNESIS_QUESTION_NOT_FOUND otherwise.
 */
async function assertQuestionsBelongToAnamnesis(anamnesisId, answers, prismaClient) {
  const questionIds = answers.map((answer) => answer.questionId);

  const knownQuestions = await prismaClient.anamnesisQuestion.findMany({
    where: {
      id: { in: questionIds },
      deletedAt: null,
      section: { anamnesisId, deletedAt: null },
    },
    select: { id: true },
  });

  const knownQuestionIds = new Set(knownQuestions.map((question) => question.id));
  const unknownQuestionId = questionIds.find((questionId) => !knownQuestionIds.has(questionId));

  if (unknownQuestionId) {
    throw new AppError({
      httpStatus: 404,
      error: AnamnesisErrorCode.ANAMNESIS_QUESTION_NOT_FOUND,
      messageCode: AnamnesisMessageCode.ANAMNESIS_QUESTION_NOT_FOUND,
      message: `Question not found: ${unknownQuestionId}`,
    });
  }
}

/**
 * Run `operation` once more when it fails with a unique-constraint violation.
 * Covers two students' requests racing to create the same response row: the loser
 * fails with P2002 and, on retry, finds the row created by the winner.
 */
async function retryOnceOnUniqueViolation(operation) {
  try {
    return await operation();
  } catch (error) {
    if (error?.code !== UNIQUE_CONSTRAINT_VIOLATION_CODE) throw error;
    return operation();
  }
}

/**
 * Apply a partial set of answers to a draft response. Only the questions present
 * in `answers` are touched: empty values clear the stored answer, the rest are upserted.
 */
async function applyDraftAnswers(tx, responseId, answers) {
  const emptyQuestionIds = answers.filter((a) => isEmptyAnswerValue(a.value)).map((a) => a.questionId);
  const filledAnswers = answers.filter((a) => !isEmptyAnswerValue(a.value));

  if (emptyQuestionIds.length > 0) {
    await tx.anamnesisAnswer.deleteMany({
      where: { responseId, questionId: { in: emptyQuestionIds } },
    });
  }

  for (const { questionId, value } of filledAnswers) {
    await tx.anamnesisAnswer.upsert({
      where: { responseId_questionId: { responseId, questionId } },
      create: { responseId, questionId, value },
      update: { value },
    });
  }
}

/**
 * Columns reset when a trainer reopens their own submitted response as a draft. Authorship
 * (filledByRole/filledByUserId) is left as is: it is meaningless while the response is a draft
 * and is overwritten by the next finalize.
 */
const REOPEN_AS_DRAFT_DATA = Object.freeze({
  submittedAt: null,
  studentConfirmedAt: null,
  trainerAttestedAt: null,
});

/**
 * What a draft save does to a response that is already submitted:
 *  - student draft (no `reopeningTrainerUserId`): never allowed (409 ALREADY_SUBMITTED);
 *  - trainer draft: allowed only when getTrainerFinalizeBlock lets that trainer finalize it,
 *    in which case the response is reopened as a draft; otherwise 409 with the block code.
 * Must run AFTER the row lock, on freshly re-read state.
 *
 * @returns {object} Extra columns to write together with the draft (empty when still a draft)
 */
function resolveDraftReopen(lockedResponse, reopeningTrainerUserId) {
  if (!lockedResponse.submittedAt) return {};

  if (!reopeningTrainerUserId) {
    throw new AppError({
      httpStatus: 409,
      error: AnamnesisErrorCode.ANAMNESIS_RESPONSE_ALREADY_SUBMITTED,
      messageCode: AnamnesisMessageCode.ANAMNESIS_RESPONSE_ALREADY_SUBMITTED,
      message: 'This anamnesis has already been submitted',
    });
  }

  assertTrainerMayFinalize(lockedResponse, reopeningTrainerUserId);

  return REOPEN_AS_DRAFT_DATA;
}

/**
 * Single draft-save transaction: get-or-create the response, lock it, check its state
 * AFTER the lock (a concurrent final POST may have just committed), apply the answers and
 * bump `updatedAt`. A submitted response is rejected, or reopened when the saver is the
 * trainer who owns it (see resolveDraftReopen).
 */
async function saveDraftInTransaction(tx, { anamnesisId, studentId, answers, reopeningTrainerUserId }) {
  const draftResponse = await tx.anamnesisResponse.upsert({
    where: { anamnesisId_studentId: { anamnesisId, studentId } },
    create: { anamnesisId, studentId, submittedAt: null },
    update: {},
  });

  await lockAnamnesisResponseForUpdate(tx, draftResponse.id);

  const lockedResponse = await tx.anamnesisResponse.findUnique({
    where: { id: draftResponse.id },
    select: { submittedAt: true, filledByRole: true, filledByUserId: true },
  });

  const reopenData = resolveDraftReopen(lockedResponse, reopeningTrainerUserId);

  await applyDraftAnswers(tx, draftResponse.id, answers);

  // The upsert above may not touch the row, so bump updatedAt explicitly ("saved at").
  return tx.anamnesisResponse.update({
    where: { id: draftResponse.id },
    data: { ...reopenData, updatedAt: new Date() },
    include: { answers: true },
  });
}

/**
 * Validate the payload of a final submit (student or trainer) against the anamnesis
 * structure and return the answers that must be persisted:
 *  - duplicated questionIds are rejected (400);
 *  - answers of questions hidden by conditional logic are dropped (fail closed);
 *  - every required, visible question must be answered (400);
 *  - answers for unknown questions are rejected (404).
 *
 * @returns {Promise<Array<{ questionId: string, value: * }>>} The visible answers
 */
async function resolveFinalAnswers(anamnesisId, answers, prismaClient) {
  assertNoDuplicateQuestionIds(answers);

  const anamnesisWithQuestions = await prismaClient.anamnesis.findUnique({
    where: { id: anamnesisId },
    include: {
      sections: {
        where: { deletedAt: null },
        include: {
          questions: {
            where: { deletedAt: null },
            include: { options: { orderBy: { order: 'asc' } } },
          },
        },
      },
    },
  });

  const allQuestions = anamnesisWithQuestions.sections.flatMap((s) => s.questions);
  const knownQuestionIds = new Set(allQuestions.map((q) => q.id));

  // Build a lookup map for normalization (needs options for SINGLE/MULTIPLE_CHOICE)
  const questionsById = new Map(allQuestions.map((q) => [q.id, q]));

  // Normalize choice answers from option text → option UUID for visibility evaluation only.
  // Persisted AnamnesisAnswer.value remains exactly what the client submitted (see visibleAnswers below).
  const answersByQuestionId = normalizeChoiceAnswersForVisibility(answers, questionsById);

  // Determine which questions are visible given the submitted answers
  const visibleQuestionIds = new Set(
    allQuestions
      .filter((q) => isQuestionVisible(q, answersByQuestionId))
      .map((q) => q.id),
  );

  // Drop answers for hidden questions (fail closed — don't persist ghost answers)
  const visibleAnswers = answers.filter((a) => visibleQuestionIds.has(a.questionId));
  const answeredVisibleQuestionIds = new Set(visibleAnswers.map((a) => a.questionId));

  // Required validation applies only to visible questions
  const missingRequiredQuestions = allQuestions.filter(
    (q) => q.required && visibleQuestionIds.has(q.id) && !answeredVisibleQuestionIds.has(q.id),
  );

  if (missingRequiredQuestions.length > 0) {
    throw new AppError({
      httpStatus: 400,
      error: 'VALIDATION_ERROR',
      messageCode: 'validation.failed',
      message: 'Required questions were not answered',
      details: missingRequiredQuestions.map((q) => ({
        questionId: q.id,
        message: 'Required question not answered',
      })),
    });
  }

  const unknownAnswer = answers.find((a) => !knownQuestionIds.has(a.questionId));
  if (unknownAnswer) {
    throw new AppError({
      httpStatus: 404,
      error: AnamnesisErrorCode.ANAMNESIS_QUESTION_NOT_FOUND,
      messageCode: AnamnesisMessageCode.ANAMNESIS_QUESTION_NOT_FOUND,
      message: `Question not found: ${unknownAnswer.questionId}`,
    });
  }

  return visibleAnswers;
}

/**
 * Why this trainer may not finalize the response, or null when they may.
 * A submitted response belongs to whoever filled it: the student's submission is never
 * replaced, and another trainer's submission is only replaceable by that trainer. When
 * the filler's user was deleted (filledByUserId SET NULL) nobody owns it anymore, so a
 * trainer who still has access may take it over.
 *
 * @param {{ submittedAt: Date|null, filledByRole: string, filledByUserId: string|null }|null} response
 * @param {string} trainerUserId
 * @returns {string|null} AnamnesisErrorCode
 */
function getTrainerFinalizeBlock(response, trainerUserId) {
  if (!response?.submittedAt) return null;
  if (response.filledByRole === AnamnesisFilledBy.STUDENT) {
    return AnamnesisErrorCode.ANAMNESIS_RESPONSE_SUBMITTED_BY_STUDENT;
  }
  if (response.filledByUserId && response.filledByUserId !== trainerUserId) {
    return AnamnesisErrorCode.ANAMNESIS_RESPONSE_FILLED_BY_ANOTHER_TRAINER;
  }
  return null;
}

const TRAINER_FINALIZE_BLOCK_MESSAGES = Object.freeze({
  [AnamnesisErrorCode.ANAMNESIS_RESPONSE_SUBMITTED_BY_STUDENT]: 'The student has already submitted this anamnesis',
  [AnamnesisErrorCode.ANAMNESIS_RESPONSE_FILLED_BY_ANOTHER_TRAINER]: 'This anamnesis was filled in by another trainer',
});

function assertTrainerMayFinalize(lockedResponse, trainerUserId) {
  const blockCode = getTrainerFinalizeBlock(lockedResponse, trainerUserId);
  if (!blockCode) return;

  throw new AppError({
    httpStatus: 409,
    error: blockCode,
    messageCode: AnamnesisMessageCode[blockCode],
    message: TRAINER_FINALIZE_BLOCK_MESSAGES[blockCode],
  });
}

/**
 * Columns written when a response is finalized. A trainer submission waits for the
 * student's confirmation; a student submission is confirmed by definition and drops any
 * previous trainer attestation (that trainer submission has just been replaced).
 */
function buildFinalizeData({ filledByRole, filledByUserId }, submittedAt) {
  const filledByTrainer = filledByRole === AnamnesisFilledBy.TRAINER;

  return {
    submittedAt,
    filledByRole,
    filledByUserId,
    trainerAttestedAt: filledByTrainer ? submittedAt : null,
    studentConfirmedAt: filledByTrainer ? null : submittedAt,
  };
}

/**
 * Single finalize transaction shared by the student and the trainer submit:
 * get-or-create the response row, lock it, re-read its state AFTER the lock (a concurrent
 * request may have just committed), decide, then replace the answers and stamp authorship.
 *
 * @param {object} tx - Prisma interactive transaction client
 * @param {object} params
 * @param {string} params.anamnesisId
 * @param {string} params.studentId - Owner of the response (the student)
 * @param {Array<{ questionId: string, value: * }>} params.answers - Already validated, visible answers
 * @param {{ filledByRole: string, filledByUserId: string }} params.authorship
 */
async function finalizeResponseInTransaction(tx, { anamnesisId, studentId, answers, authorship }) {
  const responseRow = await tx.anamnesisResponse.upsert({
    where: { anamnesisId_studentId: { anamnesisId, studentId } },
    create: { anamnesisId, studentId, submittedAt: null },
    update: {},
  });

  await lockAnamnesisResponseForUpdate(tx, responseRow.id);

  const lockedResponse = await tx.anamnesisResponse.findUnique({
    where: { id: responseRow.id },
    select: { submittedAt: true, filledByRole: true, filledByUserId: true },
  });

  if (authorship.filledByRole === AnamnesisFilledBy.TRAINER) {
    assertTrainerMayFinalize(lockedResponse, authorship.filledByUserId);
  }

  await tx.anamnesisAnswer.deleteMany({ where: { responseId: responseRow.id } });

  if (answers.length > 0) {
    await tx.anamnesisAnswer.createMany({
      data: answers.map((a) => ({
        responseId: responseRow.id,
        questionId: a.questionId,
        value: a.value,
      })),
    });
  }

  return tx.anamnesisResponse.update({
    where: { id: responseRow.id },
    data: buildFinalizeData(authorship, new Date()),
    include: { answers: true },
  });
}

/**
 * Validate and finalize a response on behalf of `authorship`. Shared by both submit flows.
 */
async function finalizeResponse({ anamnesisId, studentId, answers, authorship }, prismaClient) {
  const visibleAnswers = await resolveFinalAnswers(anamnesisId, answers, prismaClient);

  const response = await retryOnceOnUniqueViolation(() =>
    prismaClient.$transaction((tx) =>
      finalizeResponseInTransaction(tx, { anamnesisId, studentId, answers: visibleAnswers, authorship }),
    ),
  );

  return withResponseStatus(response);
}

/**
 * Save a partial (draft) response for a student. Shared by the student and trainer flows.
 * No required-question validation and no hidden-question pruning: the student may still
 * flip a parent answer back, and the final submit already drops answers of hidden questions.
 * Answers not present in the payload are never touched.
 */
async function saveDraftForStudent({ anamnesisId, studentId, answers, reopeningTrainerUserId }, prismaClient) {
  assertNoDuplicateQuestionIds(answers);
  await assertQuestionsBelongToAnamnesis(anamnesisId, answers, prismaClient);

  const response = await retryOnceOnUniqueViolation(() =>
    prismaClient.$transaction((tx) =>
      saveDraftInTransaction(tx, { anamnesisId, studentId, answers, reopeningTrainerUserId }),
    ),
  );

  return withResponseStatus(response);
}

/**
 * Save a partial (draft) response (student flow).
 *
 * @param {string} userId - Student's user ID
 * @param {string} anamnesisId
 * @param {object} data - { answers: [{ questionId, value }] }
 * @param {object} [prismaClient]
 * @returns {Promise<object>} The draft response with all answers and status
 */
export async function saveAnamnesisResponseDraft(userId, anamnesisId, { answers }, prismaClient = prisma) {
  await assertAnamnesisLinkedToStudent(userId, anamnesisId, prismaClient);

  return saveDraftForStudent({ anamnesisId, studentId: userId, answers }, prismaClient);
}

/**
 * Submit a student's response to an anamnesis. This is the "finalize" action:
 * it also converts a previously saved draft into a submitted response.
 * Validates required questions, then upserts the AnamnesisResponse record and
 * replaces all AnamnesisAnswer records atomically.
 * The response becomes student-authored and confirmed, also when it corrects a
 * response the trainer filled on the student's behalf.
 * This is an idempotent upsert — repeated calls replace the previous response.
 *
 * @param {string} userId - Student's user ID
 * @param {string} anamnesisId
 * @param {object} data - { answers: [{ questionId, value }] }
 * @param {object} [prismaClient]
 * @returns {Promise<object>} The response with answers
 */
export async function submitAnamnesisResponse(userId, anamnesisId, { answers }, prismaClient = prisma) {
  await assertAnamnesisLinkedToStudent(userId, anamnesisId, prismaClient);

  return finalizeResponse({
    anamnesisId,
    studentId: userId,
    answers,
    authorship: { filledByRole: AnamnesisFilledBy.STUDENT, filledByUserId: userId },
  }, prismaClient);
}

/**
 * Confirm, in the student's name, a response the trainer finalized on their behalf.
 * Only valid while the status is `awaiting_confirmation`; answers are left untouched.
 * The status is re-checked after the row lock so a concurrent trainer/student submit
 * cannot be silently overtaken.
 *
 * @param {string} userId - Student's user ID
 * @param {string} anamnesisId
 * @param {object} [prismaClient]
 * @returns {Promise<object>} The confirmed response with answers and status
 */
export async function confirmAnamnesisResponse(userId, anamnesisId, prismaClient = prisma) {
  await assertAnamnesisLinkedToStudent(userId, anamnesisId, prismaClient);

  const response = await prismaClient.$transaction((tx) =>
    confirmResponseInTransaction(tx, { anamnesisId, studentId: userId }),
  );

  return withResponseStatus(response);
}

async function confirmResponseInTransaction(tx, { anamnesisId, studentId }) {
  const responseRow = await tx.anamnesisResponse.findUnique({
    where: { anamnesisId_studentId: { anamnesisId, studentId } },
    select: { id: true },
  });

  if (!responseRow) {
    throw new AppError({
      httpStatus: 404,
      error: AnamnesisErrorCode.ANAMNESIS_RESPONSE_NOT_FOUND,
      messageCode: AnamnesisMessageCode.ANAMNESIS_RESPONSE_NOT_FOUND,
      message: 'No response found for this anamnesis',
    });
  }

  await lockAnamnesisResponseForUpdate(tx, responseRow.id);

  const lockedResponse = await tx.anamnesisResponse.findUnique({
    where: { id: responseRow.id },
    select: { submittedAt: true, filledByRole: true, studentConfirmedAt: true },
  });

  if (toResponseStatus(lockedResponse) !== AnamnesisResponseStatus.AWAITING_CONFIRMATION) {
    throw new AppError({
      httpStatus: 409,
      error: AnamnesisErrorCode.ANAMNESIS_RESPONSE_NOT_AWAITING_CONFIRMATION,
      messageCode: AnamnesisMessageCode.ANAMNESIS_RESPONSE_NOT_AWAITING_CONFIRMATION,
      message: 'This anamnesis is not awaiting confirmation',
    });
  }

  return tx.anamnesisResponse.update({
    where: { id: responseRow.id },
    data: { studentConfirmedAt: new Date() },
    include: { answers: true },
  });
}

// ─── Trainer fills on behalf of the student ───────────────────────────────────

/**
 * Assert this trainer linked the anamnesis to this student.
 * Throws 404 ANAMNESIS_NOT_LINKED_TO_STUDENT otherwise (also when another trainer did).
 */
async function assertAnamnesisLinkedByTrainer(trainerId, studentId, anamnesisId, prismaClient) {
  const link = await prismaClient.studentAnamnesis.findFirst({
    where: { anamnesisId, studentId, trainerId },
  });

  if (!link) {
    throw new AppError({
      httpStatus: 404,
      error: AnamnesisErrorCode.ANAMNESIS_NOT_LINKED_TO_STUDENT,
      messageCode: AnamnesisMessageCode.ANAMNESIS_NOT_LINKED_TO_STUDENT,
      message: 'This anamnesis is not linked to this student',
    });
  }
}

/**
 * Access guard shared by every "trainer fills for the student" operation: the student is
 * linked to the trainer AND active on the plan, and this trainer linked this anamnesis to
 * this student. Returns the Trainer record.
 */
async function assertTrainerCanFillAnamnesis(trainerUserId, studentId, anamnesisId, prismaClient) {
  const trainer = await verifyTrainerStudentLink(trainerUserId, studentId, prismaClient);
  await assertStudentActiveOnPlan(prismaClient, trainer.id, studentId);
  await assertAnamnesisLinkedByTrainer(trainer.id, studentId, anamnesisId, prismaClient);

  return trainer;
}

/**
 * Load what the trainer needs to fill the anamnesis with the student: the full anamnesis
 * and the current response (draft or submitted, whoever wrote it), or null.
 * The UI only calls this after the presence attestation (enforced by the route schema).
 *
 * @param {string} trainerUserId
 * @param {string} studentId
 * @param {string} anamnesisId
 * @param {object} [prismaClient]
 * @returns {Promise<{ anamnesis: object, response: object|null, canFinalize: boolean }>}
 */
export async function getTrainerFillContext(trainerUserId, studentId, anamnesisId, prismaClient = prisma) {
  await assertTrainerCanFillAnamnesis(trainerUserId, studentId, anamnesisId, prismaClient);

  const [anamnesis, response] = await Promise.all([
    prismaClient.anamnesis.findUnique({ where: { id: anamnesisId }, include: fullAnamnesisInclude }),
    prismaClient.anamnesisResponse.findUnique({
      where: { anamnesisId_studentId: { anamnesisId, studentId } },
      include: { answers: true },
    }),
  ]);

  return {
    anamnesis,
    response: response ? withResponseStatus(response) : null,
    canFinalize: getTrainerFinalizeBlock(response, trainerUserId) === null,
  };
}

/**
 * Save a partial (draft) response on behalf of the student. Same semantics as the student
 * draft, except for a response already submitted: when this trainer may finalize it (they
 * filled it in themselves, or the filler's user was deleted) it is REOPENED as a draft
 * (submittedAt, studentConfirmedAt and trainerAttestedAt reset; status "draft" until the
 * trainer finalizes again). 409 ANAMNESIS_RESPONSE_SUBMITTED_BY_STUDENT /
 * ANAMNESIS_RESPONSE_FILLED_BY_ANOTHER_TRAINER otherwise, writing nothing.
 *
 * @param {string} trainerUserId
 * @param {string} studentId
 * @param {string} anamnesisId
 * @param {object} data - { answers: [{ questionId, value }] }
 * @param {object} [prismaClient]
 * @returns {Promise<object>}
 */
export async function saveTrainerAnamnesisResponseDraft(
  trainerUserId,
  studentId,
  anamnesisId,
  { answers },
  prismaClient = prisma,
) {
  await assertTrainerCanFillAnamnesis(trainerUserId, studentId, anamnesisId, prismaClient);

  return saveDraftForStudent(
    { anamnesisId, studentId, answers, reopeningTrainerUserId: trainerUserId },
    prismaClient,
  );
}

/**
 * Finalize the response on behalf of the student. The response becomes `awaiting_confirmation`
 * until the student confirms it in the app. The trainer may re-finalize their own submission
 * (which resets the confirmation) but never overwrites one the student submitted (409).
 * The route schema guarantees the presence attestation (`attestation.studentPresent: true`).
 *
 * @param {string} trainerUserId
 * @param {string} studentId
 * @param {string} anamnesisId
 * @param {object} data - { answers: [{ questionId, value }] }
 * @param {object} [prismaClient]
 * @returns {Promise<object>}
 */
export async function submitTrainerAnamnesisResponse(
  trainerUserId,
  studentId,
  anamnesisId,
  { answers },
  prismaClient = prisma,
) {
  await assertTrainerCanFillAnamnesis(trainerUserId, studentId, anamnesisId, prismaClient);

  return finalizeResponse({
    anamnesisId,
    studentId,
    answers,
    authorship: { filledByRole: AnamnesisFilledBy.TRAINER, filledByUserId: trainerUserId },
  }, prismaClient);
}

/**
 * Get the authenticated student's response to an anamnesis.
 *
 * @param {string} userId - Student's user ID
 * @param {string} anamnesisId
 * @returns {Promise<object>}
 */
export async function getMyAnamnesisResponse(userId, anamnesisId) {
  await assertAnamnesisLinkedToStudent(userId, anamnesisId);

  const response = await prisma.anamnesisResponse.findUnique({
    where: { anamnesisId_studentId: { anamnesisId, studentId: userId } },
    include: { answers: true },
  });

  if (!response) {
    throw new AppError({
      httpStatus: 404,
      error: AnamnesisErrorCode.ANAMNESIS_RESPONSE_NOT_FOUND,
      messageCode: AnamnesisMessageCode.ANAMNESIS_RESPONSE_NOT_FOUND,
      message: 'No response found for this anamnesis',
    });
  }

  return withResponseStatus(response);
}

/**
 * Get a student's response to an anamnesis (trainer view).
 * Verifies the trainer owns the student relationship and that this trainer
 * linked the anamnesis to the student.
 *
 * @param {string} trainerUserId - Trainer's user ID
 * @param {string} studentId - Student's user ID
 * @param {string} anamnesisId
 * @returns {Promise<object>}
 */
export async function getStudentAnamnesisResponse(trainerUserId, studentId, anamnesisId) {
  const trainer = await verifyTrainerStudentLink(trainerUserId, studentId);

  await assertAnamnesisLinkedByTrainer(trainer.id, studentId, anamnesisId, prisma);

  // Drafts (submittedAt = null) are private to the student — trainers only see submitted responses.
  const response = await prisma.anamnesisResponse.findFirst({
    where: { anamnesisId, studentId, submittedAt: { not: null } },
    include: { answers: true },
  });

  if (!response) {
    throw new AppError({
      httpStatus: 404,
      error: AnamnesisErrorCode.ANAMNESIS_RESPONSE_NOT_FOUND,
      messageCode: AnamnesisMessageCode.ANAMNESIS_RESPONSE_NOT_FOUND,
      message: 'The student has not submitted a response for this anamnesis',
    });
  }

  return withResponseStatus(response);
}
