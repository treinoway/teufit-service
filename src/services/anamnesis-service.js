import { prisma } from '../db.js';
import { AppError } from '../errors/app-error.js';
import {
  AnamnesisErrorCode,
  AnamnesisMessageCode,
  questionTypesWithOptions,
  isQuestionVisible,
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
async function findTrainerOrThrow(userId) {
  const trainer = await prisma.trainer.findUnique({
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
async function verifyTrainerStudentLink(trainerUserId, studentId) {
  const trainer = await findTrainerOrThrow(trainerUserId);

  const link = await prisma.trainerStudent.findUnique({
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

  await prisma.$transaction(async (tx) => {
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
  });

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

  await prisma.$transaction(async (tx) => {
    await tx.anamnesisQuestion.updateMany({
      where: { sectionId, deletedAt: null },
      data: { deletedAt: now },
    });

    await tx.anamnesisSection.update({
      where: { id: sectionId },
      data: { deletedAt: now },
    });
  });

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

  await prisma.$transaction(
    orderedIds.map((sectionId, index) =>
      prisma.anamnesisSection.update({
        where: { id: sectionId },
        data: { order: index },
      }),
    ),
  );

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
    validateQuestionType(data.type);
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
 * List all anamneses linked to a student by this trainer.
 *
 * @param {string} userId - Trainer's user ID
 * @param {string} studentId
 * @returns {Promise<object[]>}
 */
export async function listStudentAnamneses(userId, studentId) {
  const trainer = await verifyTrainerStudentLink(userId, studentId);

  const links = await prisma.studentAnamnesis.findMany({
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

  return links;
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
 * Get all anamneses linked to the authenticated student.
 *
 * @param {string} userId - Student's user ID
 * @returns {Promise<object[]>}
 */
export async function getMyAnamneses(userId) {
  const links = await prisma.studentAnamnesis.findMany({
    where: { studentId: userId },
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
            orderBy: { order: 'asc' },
            include: {
              questions: {
                where: { deletedAt: null },
                orderBy: { order: 'asc' },
                include: { options: { orderBy: { order: 'asc' } } },
                // parentQuestionId and condition are returned via default field selection
              },
            },
          },
        },
      },
      trainer: {
        select: {
          id: true,
          user: { select: { firstName: true, lastName: true, avatarUrl: true } },
        },
      },
    },
  });

  return links;
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

/**
 * Submit a student's response to an anamnesis.
 * Validates required questions, then upserts the AnamnesisResponse record and
 * replaces all AnamnesisAnswer records atomically.
 * This is an idempotent upsert — repeated calls replace the previous response.
 *
 * @param {string} userId - Student's user ID
 * @param {string} anamnesisId
 * @param {object} data - { answers: [{ questionId, value }] }
 * @returns {Promise<object>} The response with answers
 */
export async function submitAnamnesisResponse(userId, anamnesisId, { answers }) {
  const link = await prisma.studentAnamnesis.findFirst({
    where: { studentId: userId, anamnesisId },
  });

  if (!link) {
    throw new AppError({
      httpStatus: 404,
      error: AnamnesisErrorCode.ANAMNESIS_NOT_LINKED_TO_STUDENT,
      messageCode: AnamnesisMessageCode.ANAMNESIS_NOT_LINKED_TO_STUDENT,
      message: 'This anamnesis is not linked to your account',
    });
  }

  const anamnesisWithQuestions = await prisma.anamnesis.findUnique({
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

  const response = await prisma.$transaction(async (tx) => {
    const upsertedResponse = await tx.anamnesisResponse.upsert({
      where: { anamnesisId_studentId: { anamnesisId, studentId: userId } },
      create: { anamnesisId, studentId: userId, submittedAt: new Date() },
      update: { submittedAt: new Date() },
    });

    await tx.anamnesisAnswer.deleteMany({ where: { responseId: upsertedResponse.id } });

    if (visibleAnswers.length > 0) {
      await tx.anamnesisAnswer.createMany({
        data: visibleAnswers.map((a) => ({
          responseId: upsertedResponse.id,
          questionId: a.questionId,
          value: a.value,
        })),
      });
    }

    return tx.anamnesisResponse.findUnique({
      where: { id: upsertedResponse.id },
      include: { answers: true },
    });
  });

  return response;
}

/**
 * Get the authenticated student's response to an anamnesis.
 *
 * @param {string} userId - Student's user ID
 * @param {string} anamnesisId
 * @returns {Promise<object>}
 */
export async function getMyAnamnesisResponse(userId, anamnesisId) {
  const link = await prisma.studentAnamnesis.findFirst({
    where: { studentId: userId, anamnesisId },
  });

  if (!link) {
    throw new AppError({
      httpStatus: 404,
      error: AnamnesisErrorCode.ANAMNESIS_NOT_LINKED_TO_STUDENT,
      messageCode: AnamnesisMessageCode.ANAMNESIS_NOT_LINKED_TO_STUDENT,
      message: 'This anamnesis is not linked to your account',
    });
  }

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

  return response;
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

  const studentAnamnesisLink = await prisma.studentAnamnesis.findFirst({
    where: { anamnesisId, studentId, trainerId: trainer.id },
  });

  if (!studentAnamnesisLink) {
    throw new AppError({
      httpStatus: 404,
      error: AnamnesisErrorCode.ANAMNESIS_NOT_LINKED_TO_STUDENT,
      messageCode: AnamnesisMessageCode.ANAMNESIS_NOT_LINKED_TO_STUDENT,
      message: 'This anamnesis is not linked to this student',
    });
  }

  const response = await prisma.anamnesisResponse.findUnique({
    where: { anamnesisId_studentId: { anamnesisId, studentId } },
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

  return response;
}
