import { prisma } from '../db.js';
import {
  NotFoundAppError,
  ForbiddenAppError,
  ConflictAppError,
  AppError,
} from '../errors/app-error.js';
import {
  AnamnesisErrorCode,
  AnamnesisMessageCode,
  anamnesisQuestionTypeValues,
  questionTypesWithOptions,
} from '../constants/anamnesis.js';

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Load the Trainer record for the given userId or throw 404.
 */
async function findTrainerOrThrow(userId) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw new NotFoundAppError({
      error: 'TRAINER_PROFILE_MISSING',
      messageCode: 'trainer.notFound',
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
    throw new NotFoundAppError({
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
    throw new ForbiddenAppError({
      error: AnamnesisErrorCode.FORBIDDEN_GENERAL_ANAMNESIS,
      messageCode: AnamnesisMessageCode.FORBIDDEN_GENERAL_ANAMNESIS,
      message: 'General anamneses cannot be modified',
    });
  }

  if (anamnesis.trainerId !== trainerId) {
    throw new ForbiddenAppError({
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
async function verifyTrainerStudentLink(trainerId, studentId) {
  const trainer = await findTrainerOrThrow(trainerId);

  const link = await prisma.trainerStudent.findUnique({
    where: { trainerId_studentId: { trainerId: trainer.id, studentId } },
  });

  if (!link) {
    throw new NotFoundAppError({
      error: 'STUDENT_NOT_FOUND',
      messageCode: 'student.notFound',
      message: 'Student not found or not assigned to you',
    });
  }

  return trainer;
}

/**
 * Load a section that belongs to a given anamnesis (excluding soft-deleted).
 */
async function findSectionOrThrow(anamnesisId, sectionId) {
  const section = await prisma.anamnesisSection.findUnique({
    where: { id: sectionId },
  });

  if (!section || section.deletedAt || section.anamnesisId !== anamnesisId) {
    throw new NotFoundAppError({
      error: AnamnesisErrorCode.ANAMNESIS_SECTION_NOT_FOUND,
      messageCode: AnamnesisMessageCode.ANAMNESIS_SECTION_NOT_FOUND,
      message: 'Anamnesis section not found',
    });
  }

  return section;
}

/**
 * Load a question that belongs to a given section (excluding soft-deleted).
 */
async function findQuestionOrThrow(sectionId, questionId) {
  const question = await prisma.anamnesisQuestion.findUnique({
    where: { id: questionId },
    include: { options: { orderBy: { order: 'asc' } } },
  });

  if (!question || question.deletedAt || question.sectionId !== sectionId) {
    throw new NotFoundAppError({
      error: AnamnesisErrorCode.ANAMNESIS_QUESTION_NOT_FOUND,
      messageCode: AnamnesisMessageCode.ANAMNESIS_QUESTION_NOT_FOUND,
      message: 'Anamnesis question not found',
    });
  }

  return question;
}

/**
 * Validate that the question type is a known value.
 */
function validateQuestionType(type) {
  if (!anamnesisQuestionTypeValues.includes(type)) {
    throw new AppError({
      httpStatus: 400,
      error: AnamnesisErrorCode.INVALID_QUESTION_TYPE,
      messageCode: AnamnesisMessageCode.INVALID_QUESTION_TYPE,
      message: `Invalid question type: ${type}. Valid values are: ${anamnesisQuestionTypeValues.join(', ')}`,
    });
  }
}

/**
 * Build Prisma create data for a set of questions (with options).
 */
function buildQuestionsCreateData(questions) {
  return questions.map((q, index) => {
    validateQuestionType(q.type);
    return {
      text: q.text,
      type: q.type,
      required: q.required ?? false,
      order: q.order ?? index,
      config: q.config ?? null,
      options: questionTypesWithOptions.includes(q.type) && q.options?.length
        ? {
            create: q.options.map((opt, optIndex) => ({
              text: opt.text,
              order: opt.order ?? optIndex,
            })),
          }
        : undefined,
    };
  });
}

/**
 * Build the full nested include for a complete anamnesis response.
 */
const fullAnamnesisInclude = {
  sections: {
    where: { deletedAt: null },
    orderBy: { order: 'asc' },
    include: {
      questions: {
        where: { deletedAt: null },
        orderBy: { order: 'asc' },
        include: {
          options: { orderBy: { order: 'asc' } },
        },
      },
    },
  },
};

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
    throw new ForbiddenAppError({
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
 * @param {object} data - { text, type, required, order, config, options }
 * @returns {Promise<object>}
 */
export async function addQuestion(userId, anamnesisId, sectionId, data) {
  const trainer = await findTrainerOrThrow(userId);
  const anamnesis = await findAnamnesisOrThrow(anamnesisId);

  verifyAnamnesisOwnership(anamnesis, trainer.id);
  await assertAnamnesisNotLinked(anamnesisId);
  await findSectionOrThrow(anamnesisId, sectionId);
  validateQuestionType(data.type);

  const question = await prisma.anamnesisQuestion.create({
    data: {
      sectionId,
      text: data.text,
      type: data.type,
      required: data.required ?? false,
      order: data.order ?? 0,
      config: data.config ?? null,
      options: questionTypesWithOptions.includes(data.type) && data.options?.length
        ? {
            create: data.options.map((opt, index) => ({
              text: opt.text,
              order: opt.order ?? index,
            })),
          }
        : undefined,
    },
    include: { options: { orderBy: { order: 'asc' } } },
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
 * @param {object} data - { text, type, required, order, config, options }
 * @returns {Promise<object>}
 */
export async function updateQuestion(userId, anamnesisId, sectionId, questionId, data) {
  const trainer = await findTrainerOrThrow(userId);
  const anamnesis = await findAnamnesisOrThrow(anamnesisId);

  verifyAnamnesisOwnership(anamnesis, trainer.id);
  await assertAnamnesisNotLinked(anamnesisId);
  await findSectionOrThrow(anamnesisId, sectionId);
  await findQuestionOrThrow(sectionId, questionId);

  if (data.type !== undefined) {
    validateQuestionType(data.type);
  }

  const effectiveType = data.type ?? (await prisma.anamnesisQuestion.findUnique({ where: { id: questionId }, select: { type: true } })).type;

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
      },
      include: { options: { orderBy: { order: 'asc' } } },
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
    throw new ForbiddenAppError({
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
      throw new ConflictAppError({
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
    throw new NotFoundAppError({
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
          },
        });

        if (question.options.length > 0) {
          await tx.anamnesisQuestionOption.createMany({
            data: question.options.map((opt) => ({
              questionId: newQuestion.id,
              text: opt.text,
              order: opt.order,
            })),
          });
        }
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
    throw new ForbiddenAppError({
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
          },
        });

        if (question.options.length > 0) {
          await tx.anamnesisQuestionOption.createMany({
            data: question.options.map((opt) => ({
              questionId: newQuestion.id,
              text: opt.text,
              order: opt.order,
            })),
          });
        }
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
          },
        },
      },
    },
  });

  const allQuestions = anamnesisWithQuestions.sections.flatMap((s) => s.questions);
  const knownQuestionIds = new Set(allQuestions.map((q) => q.id));
  const answeredQuestionIds = new Set(answers.map((a) => a.questionId));

  const missingRequiredQuestions = allQuestions.filter(
    (q) => q.required && !answeredQuestionIds.has(q.id),
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

    if (answers.length > 0) {
      await tx.anamnesisAnswer.createMany({
        data: answers.map((a) => ({
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
