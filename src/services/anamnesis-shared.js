import { prisma } from '../db.js';
import { AppError } from '../errors/app-error.js';
import {
  AnamnesisErrorCode,
  AnamnesisMessageCode,
  anamnesisQuestionTypeValues,
  questionTypesWithOptions,
} from '../constants/anamnesis.js';

// ─── Shared helpers used by both anamnesis-service.js and admin-anamnesis-service.js

/**
 * Build the full nested include for a complete anamnesis response.
 */
export const fullAnamnesisInclude = {
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

/**
 * Load a section that belongs to a given anamnesis (excluding soft-deleted).
 * Throws 404 with ANAMNESIS_SECTION_NOT_FOUND if not found.
 */
export async function findSectionOrThrow(anamnesisId, sectionId) {
  const section = await prisma.anamnesisSection.findUnique({
    where: { id: sectionId },
  });

  if (!section || section.deletedAt || section.anamnesisId !== anamnesisId) {
    throw new AppError({
      httpStatus: 404,
      error: AnamnesisErrorCode.ANAMNESIS_SECTION_NOT_FOUND,
      messageCode: AnamnesisMessageCode.ANAMNESIS_SECTION_NOT_FOUND,
      message: 'Anamnesis section not found',
    });
  }

  return section;
}

/**
 * Load a question that belongs to a given section (excluding soft-deleted).
 * Throws 404 with ANAMNESIS_QUESTION_NOT_FOUND if not found.
 */
export async function findQuestionOrThrow(sectionId, questionId) {
  const question = await prisma.anamnesisQuestion.findUnique({
    where: { id: questionId },
    include: { options: { orderBy: { order: 'asc' } } },
  });

  if (!question || question.deletedAt || question.sectionId !== sectionId) {
    throw new AppError({
      httpStatus: 404,
      error: AnamnesisErrorCode.ANAMNESIS_QUESTION_NOT_FOUND,
      messageCode: AnamnesisMessageCode.ANAMNESIS_QUESTION_NOT_FOUND,
      message: 'Anamnesis question not found',
    });
  }

  return question;
}

/**
 * Validate that the question type is a known value.
 * Throws 400 with INVALID_QUESTION_TYPE if invalid.
 */
export function validateQuestionType(type) {
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
export function buildQuestionsCreateData(questions) {
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
 * Validate that every ID in orderedIds belongs to the given anamnesis
 * (non-deleted sections only). Throws VALIDATION_ERROR if any ID is foreign.
 *
 * @param {string} anamnesisId
 * @param {string[]} orderedIds
 */
export async function validateSectionIds(anamnesisId, orderedIds) {
  const existingSections = await prisma.anamnesisSection.findMany({
    where: { anamnesisId, deletedAt: null },
    select: { id: true },
  });

  const existingIdSet = new Set(existingSections.map((s) => s.id));
  const foreignId = orderedIds.find((id) => !existingIdSet.has(id));

  if (foreignId) {
    throw new AppError({
      httpStatus: 400,
      error: 'VALIDATION_ERROR',
      messageCode: 'validation.failed',
      message: `Section ID does not belong to this anamnesis: ${foreignId}`,
      details: [{ sectionId: foreignId, message: 'Section not found in this anamnesis' }],
    });
  }
}
