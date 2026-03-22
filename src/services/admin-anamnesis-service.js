import { prisma } from '../db.js';
import { AppError } from '../errors/app-error.js';
import {
  AnamnesisErrorCode,
  AnamnesisMessageCode,
  questionTypesWithOptions,
} from '../constants/anamnesis.js';
import {
  fullAnamnesisInclude,
  findSectionOrThrow,
  findQuestionOrThrow,
  validateQuestionType,
  buildQuestionsCreateData,
  validateSectionIds,
} from './anamnesis-shared.js';

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Load a public (isGeneral: true) anamnesis by id.
 * Throws 404 if not found, soft-deleted, or not public.
 */
async function findPublicAnamnesisOrThrow(anamnesisId) {
  const anamnesis = await prisma.anamnesis.findUnique({
    where: { id: anamnesisId },
  });

  if (!anamnesis || anamnesis.deletedAt || !anamnesis.isGeneral) {
    throw new AppError({
      httpStatus: 404,
      error: AnamnesisErrorCode.ANAMNESIS_NOT_FOUND,
      messageCode: AnamnesisMessageCode.ANAMNESIS_NOT_FOUND,
      message: 'Public anamnesis not found',
    });
  }

  return anamnesis;
}

/**
 * Assert the anamnesis has no linked students.
 * Throws 409 if any StudentAnamnesis record references this anamnesis.
 * Must be called before any structural mutation.
 */
async function assertAnamnesisNotLinked(anamnesisId) {
  const count = await prisma.studentAnamnesis.count({ where: { anamnesisId } });
  if (count > 0) {
    throw new AppError({
      httpStatus: 409,
      error: AnamnesisErrorCode.ANAMNESIS_HAS_STUDENT_LINKS,
      messageCode: AnamnesisMessageCode.ANAMNESIS_HAS_STUDENT_LINKS,
      message: 'This anamnesis is linked to students and cannot be modified.',
    });
  }
}

// ─── Public Anamnesis CRUD ────────────────────────────────────────────────────

/**
 * Create a new public anamnesis (isGeneral: true, trainerId: null)
 * with optional nested sections/questions/options.
 *
 * @param {object} data - { title, description, sections }
 * @returns {Promise<object>} The created anamnesis with full nested structure
 */
export async function createPublicAnamnesis(data) {
  // Pre-validate question types before entering the transaction so that
  // validation errors are thrown immediately and predictably.
  const sectionsCreateData = data.sections?.length
    ? data.sections.map((section, sectionIndex) => ({
        title: section.title,
        description: section.description ?? null,
        order: section.order ?? sectionIndex,
        questions: section.questions?.length
          ? { create: buildQuestionsCreateData(section.questions) }
          : undefined,
      }))
    : null;

  const anamnesis = await prisma.$transaction(async (tx) => {
    const created = await tx.anamnesis.create({
      data: {
        trainerId: null,
        title: data.title,
        description: data.description ?? null,
        isGeneral: true,
        sections: sectionsCreateData
          ? { create: sectionsCreateData }
          : undefined,
      },
      include: fullAnamnesisInclude,
    });

    return created;
  });

  return anamnesis;
}

/**
 * List all public (isGeneral: true) anamneses with sections summary.
 *
 * @returns {Promise<object[]>}
 */
export async function listPublicAnamneses() {
  const anamneses = await prisma.anamnesis.findMany({
    where: { isGeneral: true, deletedAt: null },
    orderBy: { createdAt: 'desc' },
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
 * Get full detail of a public anamnesis.
 *
 * @param {string} anamnesisId
 * @returns {Promise<object>}
 */
export async function getPublicAnamnesisById(anamnesisId) {
  await findPublicAnamnesisOrThrow(anamnesisId);

  return prisma.anamnesis.findUnique({
    where: { id: anamnesisId },
    include: fullAnamnesisInclude,
  });
}

/**
 * Update a public anamnesis title/description.
 * Blocks update if the anamnesis is linked to students.
 *
 * @param {string} anamnesisId
 * @param {object} data - { title, description }
 * @returns {Promise<object>}
 */
export async function updatePublicAnamnesis(anamnesisId, data) {
  await findPublicAnamnesisOrThrow(anamnesisId);
  await assertAnamnesisNotLinked(anamnesisId);

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
 * Soft-delete a public anamnesis with cascade to sections and questions.
 * Blocks deletion if the anamnesis is linked to students.
 *
 * @param {string} anamnesisId
 * @returns {Promise<object>}
 */
export async function deletePublicAnamnesis(anamnesisId) {
  await findPublicAnamnesisOrThrow(anamnesisId);
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

// ─── Public Section CRUD ──────────────────────────────────────────────────────

/**
 * Add a section (with optional questions/options) to a public anamnesis.
 *
 * @param {string} anamnesisId
 * @param {object} data - { title, description, order, questions }
 * @returns {Promise<object>}
 */
export async function addPublicSection(anamnesisId, data) {
  await findPublicAnamnesisOrThrow(anamnesisId);

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
 * Update a section on a public anamnesis.
 *
 * @param {string} anamnesisId
 * @param {string} sectionId
 * @param {object} data - { title, description, order }
 * @returns {Promise<object>}
 */
export async function updatePublicSection(anamnesisId, sectionId, data) {
  await findPublicAnamnesisOrThrow(anamnesisId);
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
 * Soft-delete a section on a public anamnesis, cascading to its questions.
 *
 * @param {string} anamnesisId
 * @param {string} sectionId
 * @returns {Promise<object>}
 */
export async function deletePublicSection(anamnesisId, sectionId) {
  await findPublicAnamnesisOrThrow(anamnesisId);
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
 * Reorder sections on a public anamnesis.
 * Validates that all provided IDs belong to the anamnesis before updating.
 *
 * @param {string} anamnesisId
 * @param {string[]} orderedIds - Section IDs in the desired order
 * @returns {Promise<object[]>}
 */
export async function reorderPublicSections(anamnesisId, orderedIds) {
  await findPublicAnamnesisOrThrow(anamnesisId);
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

// ─── Public Question CRUD ─────────────────────────────────────────────────────

/**
 * Add a question (with optional options) to a section on a public anamnesis.
 *
 * @param {string} anamnesisId
 * @param {string} sectionId
 * @param {object} data - { text, type, required, order, config, options }
 * @returns {Promise<object>}
 */
export async function addPublicQuestion(anamnesisId, sectionId, data) {
  await findPublicAnamnesisOrThrow(anamnesisId);
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
 * Update a question on a public anamnesis.
 * If options are provided, they completely replace existing options.
 *
 * @param {string} anamnesisId
 * @param {string} sectionId
 * @param {string} questionId
 * @param {object} data - { text, type, required, order, config, options }
 * @returns {Promise<object>}
 */
export async function updatePublicQuestion(anamnesisId, sectionId, questionId, data) {
  await findPublicAnamnesisOrThrow(anamnesisId);
  await findSectionOrThrow(anamnesisId, sectionId);
  await findQuestionOrThrow(sectionId, questionId);

  if (data.type !== undefined) {
    validateQuestionType(data.type);
  }

  const effectiveType = data.type
    ?? (await prisma.anamnesisQuestion.findUnique({ where: { id: questionId }, select: { type: true } })).type;

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
 * Soft-delete a question on a public anamnesis.
 *
 * @param {string} anamnesisId
 * @param {string} sectionId
 * @param {string} questionId
 * @returns {Promise<object>}
 */
export async function deletePublicQuestion(anamnesisId, sectionId, questionId) {
  await findPublicAnamnesisOrThrow(anamnesisId);
  await findSectionOrThrow(anamnesisId, sectionId);
  await findQuestionOrThrow(sectionId, questionId);

  const now = new Date();

  await prisma.anamnesisQuestion.update({
    where: { id: questionId },
    data: { deletedAt: now },
  });

  return { id: questionId, deletedAt: now };
}
