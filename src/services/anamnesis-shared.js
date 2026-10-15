import { prisma } from '../db.js';
import { AppError } from '../errors/app-error.js';
import {
  AnamnesisErrorCode,
  AnamnesisMessageCode,
  AnamnesisQuestionType,
  anamnesisQuestionTypeValues,
  anamnesisCreatableQuestionTypes,
  questionTypesWithOptions,
  anamnesisParentEligibleTypes,
  validateCondition,
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
 * Validate the question type of a write (create or update).
 * Throws 400 with INVALID_QUESTION_TYPE when the type is unknown or retired (`matrix`).
 * A retired type is tolerated only when it is the question's current type (`existingType`),
 * so a legacy question can still be edited without changing its type.
 *
 * @param {string} type
 * @param {{ existingType?: string }} [options]
 */
export function validateQuestionType(type, { existingType } = {}) {
  if (!anamnesisQuestionTypeValues.includes(type)) {
    throw new AppError({
      httpStatus: 400,
      error: AnamnesisErrorCode.INVALID_QUESTION_TYPE,
      messageCode: AnamnesisMessageCode.INVALID_QUESTION_TYPE,
      message: `Invalid question type: ${type}. Valid values are: ${anamnesisCreatableQuestionTypes.join(', ')}`,
    });
  }

  if (!anamnesisCreatableQuestionTypes.includes(type) && type !== existingType) {
    throw new AppError({
      httpStatus: 400,
      error: AnamnesisErrorCode.INVALID_QUESTION_TYPE,
      messageCode: AnamnesisMessageCode.INVALID_QUESTION_TYPE,
      message: `Question type "${type}" is no longer supported. Valid values are: ${anamnesisCreatableQuestionTypes.join(', ')}`,
    });
  }
}

/**
 * Build Prisma create data for a set of questions (with options).
 * Note: parentQuestionId and condition are intentionally excluded here —
 * they are remapped in a second pass during fork/copy operations.
 * For single-question creates (addQuestion), those fields are set directly.
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
      // parentQuestionId and condition are excluded here; fork/copy handles them in a second pass
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
 * Validate that a parent-child link is valid before creating or updating a question.
 *
 * Rules enforced:
 * - parentQuestion must exist, be non-deleted, and belong to the same section as the child
 * - parentQuestion.type must be in anamnesisParentEligibleTypes
 * - parentQuestion must not itself have a parentQuestionId (single-level rule)
 * - condition must be structurally valid for the parent type (delegated to validateCondition)
 *
 * @param {{ parentId: string, childSectionId: string, condition: object }} params
 * @param {object} [prismaClient] - Optional: injected Prisma client (defaults to singleton for backward compat)
 */
export async function validateParentLink({ parentId, childSectionId, condition }, prismaClient = prisma) {
  const parentQuestion = await prismaClient.anamnesisQuestion.findUnique({
    where: { id: parentId },
    include: { options: { orderBy: { order: 'asc' } } },
  });

  if (!parentQuestion || parentQuestion.deletedAt) {
    throw new AppError({
      httpStatus: 404,
      error: AnamnesisErrorCode.ANAMNESIS_QUESTION_NOT_FOUND,
      messageCode: AnamnesisMessageCode.ANAMNESIS_QUESTION_NOT_FOUND,
      message: 'Parent question not found.',
    });
  }

  if (parentQuestion.sectionId !== childSectionId) {
    throw new AppError({
      httpStatus: 400,
      error: AnamnesisErrorCode.PARENT_MUST_BE_SAME_SECTION,
      messageCode: AnamnesisMessageCode.PARENT_MUST_BE_SAME_SECTION,
      message: 'The parent question must be in the same section as the child question.',
    });
  }

  if (!anamnesisParentEligibleTypes.includes(parentQuestion.type)) {
    throw new AppError({
      httpStatus: 400,
      error: AnamnesisErrorCode.PARENT_NOT_ELIGIBLE,
      messageCode: AnamnesisMessageCode.PARENT_NOT_ELIGIBLE,
      message: 'Only dichotomous, single choice, or multiple choice questions can be parent questions.',
    });
  }

  if (parentQuestion.parentQuestionId) {
    throw new AppError({
      httpStatus: 400,
      error: AnamnesisErrorCode.CONDITIONAL_DEPTH_EXCEEDED,
      messageCode: AnamnesisMessageCode.CONDITIONAL_DEPTH_EXCEEDED,
      message: 'Conditional questions cannot be chained — only one level of depth is allowed.',
    });
  }

  validateCondition(parentQuestion, condition);
}

/**
 * Normalize choice answers from option text to option UUID for visibility evaluation only.
 *
 * The student frontend has always submitted option text as the answer value for
 * SINGLE_CHOICE and MULTIPLE_CHOICE questions. The visibility predicate (isQuestionVisible)
 * compares against option UUIDs (condition.optionId / condition.optionIds). Without
 * normalization, conditional child questions are never considered visible, causing silent
 * required-field bypasses and dropped valid child answers.
 *
 * Rules:
 * - SINGLE_CHOICE: if value matches an option's text, substitute its id.
 *   If it already matches an option's id, leave it (forward-compatible).
 *   If it matches neither, leave it untouched (visibility → false, which is the safe default).
 * - MULTIPLE_CHOICE: apply the same text→id substitution to each entry in the array.
 * - All other types: pass through unchanged.
 * - Nullish answers: pass through unchanged.
 *
 * IMPORTANT: this function is used ONLY for visibility evaluation. The persisted
 * AnamnesisAnswer.value is always exactly what the client submitted — never rewritten.
 *
 * @param {Array<{ questionId: string, value: * }>} answers - Raw answers from the client
 * @param {Map<string, { type: string, options: Array<{ id: string, text: string }> }>} questionsById
 * @returns {Map<string, *>} Normalized answers keyed by questionId, for use with isQuestionVisible
 */
export function normalizeChoiceAnswersForVisibility(answers, questionsById) {
  const { SINGLE_CHOICE, MULTIPLE_CHOICE } = AnamnesisQuestionType;
  const normalized = new Map();

  for (const answer of answers) {
    const question = questionsById.get(answer.questionId);

    if (!question || answer.value === undefined || answer.value === null) {
      normalized.set(answer.questionId, answer.value);
      continue;
    }

    if (question.type === SINGLE_CHOICE) {
      normalized.set(answer.questionId, normalizeSingleChoiceValue(answer.value, question.options));
      continue;
    }

    if (question.type === MULTIPLE_CHOICE) {
      normalized.set(answer.questionId, normalizeMultipleChoiceValue(answer.value, question.options));
      continue;
    }

    normalized.set(answer.questionId, answer.value);
  }

  return normalized;
}

/**
 * For a SINGLE_CHOICE answer, map text → id if a matching option is found by text.
 * If the value already matches an option id, return it unchanged.
 * If no match is found, return the value unchanged (visibility will evaluate to false).
 *
 * @param {string} value
 * @param {Array<{ id: string, text: string }>} options
 * @returns {string}
 */
function normalizeSingleChoiceValue(value, options) {
  if (!Array.isArray(options)) return value;

  const byId = options.find((o) => o.id === value);
  if (byId) return value; // already an id — no mapping needed

  const byText = options.find((o) => o.text === value);
  return byText ? byText.id : value;
}

/**
 * For a MULTIPLE_CHOICE answer, apply text→id normalization to each entry in the array.
 * Non-array values pass through unchanged (visibility will evaluate to false).
 *
 * @param {*} value
 * @param {Array<{ id: string, text: string }>} options
 * @returns {*}
 */
function normalizeMultipleChoiceValue(value, options) {
  if (!Array.isArray(value) || !Array.isArray(options)) return value;
  return value.map((entry) => normalizeSingleChoiceValue(entry, options));
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
