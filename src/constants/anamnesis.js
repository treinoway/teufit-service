/**
 * Anamnesis system constants
 * Used for validation and type safety across the anamnesis feature
 */

import { AppError } from '../errors/app-error.js';

export const AnamnesisQuestionType = Object.freeze({
  FREE_TEXT: 'free_text',
  DICHOTOMOUS: 'dichotomous',
  MULTIPLE_CHOICE: 'multiple_choice',
  NUMERIC: 'numeric',
  SINGLE_CHOICE: 'single_choice',
  MATRIX: 'matrix',
});

export const anamnesisQuestionTypeValues = Object.freeze(Object.values(AnamnesisQuestionType));

// Question types that require options (checkbox/radio items or matrix rows)
export const questionTypesWithOptions = Object.freeze([
  AnamnesisQuestionType.MULTIPLE_CHOICE,
  AnamnesisQuestionType.SINGLE_CHOICE,
  AnamnesisQuestionType.MATRIX,
]);

// Question types that are eligible to be a parent (trigger) in conditional logic
export const anamnesisParentEligibleTypes = Object.freeze([
  AnamnesisQuestionType.DICHOTOMOUS,
  AnamnesisQuestionType.SINGLE_CHOICE,
  AnamnesisQuestionType.MULTIPLE_CHOICE,
]);

// Operators used in condition JSONB objects
export const AnamnesisConditionOperator = Object.freeze({
  EQUALS: 'equals',
  INCLUDES_ANY: 'includesAny',
});

// Lifecycle of an anamnesis response. Derived from AnamnesisResponse columns
// (see toResponseStatus) — never persisted as its own column.
export const AnamnesisResponseStatus = Object.freeze({
  DRAFT: 'draft',
  AWAITING_CONFIRMATION: 'awaiting_confirmation',
  SUBMITTED: 'submitted',
});

// Who wrote (finalized) the response. Persisted in AnamnesisResponse.filledByRole.
export const AnamnesisFilledBy = Object.freeze({
  STUDENT: 'student',
  TRAINER: 'trainer',
});

// Upper bound of answers accepted in one draft save request
export const ANAMNESIS_DRAFT_MAX_ANSWERS = 300;

/**
 * Derive the response status from its persisted columns.
 *  - no `submittedAt`                                            -> draft
 *  - submitted by the trainer and not yet confirmed by student   -> awaiting_confirmation
 *  - anything else (incl. legacy rows: role student, no confirm) -> submitted
 *
 * @param {{ submittedAt?: Date|null, filledByRole?: string, studentConfirmedAt?: Date|null }} response
 * @returns {string} One of AnamnesisResponseStatus
 */
export function toResponseStatus({ submittedAt, filledByRole, studentConfirmedAt }) {
  if (!submittedAt) return AnamnesisResponseStatus.DRAFT;

  if (filledByRole === AnamnesisFilledBy.TRAINER && !studentConfirmedAt) {
    return AnamnesisResponseStatus.AWAITING_CONFIRMATION;
  }

  return AnamnesisResponseStatus.SUBMITTED;
}

// Error codes used in the anamnesis service
export const AnamnesisErrorCode = Object.freeze({
  ANAMNESIS_NOT_FOUND: 'ANAMNESIS_NOT_FOUND',
  ANAMNESIS_SECTION_NOT_FOUND: 'ANAMNESIS_SECTION_NOT_FOUND',
  ANAMNESIS_QUESTION_NOT_FOUND: 'ANAMNESIS_QUESTION_NOT_FOUND',
  FORBIDDEN_NOT_ANAMNESIS_OWNER: 'FORBIDDEN_NOT_ANAMNESIS_OWNER',
  FORBIDDEN_GENERAL_ANAMNESIS: 'FORBIDDEN_GENERAL_ANAMNESIS',
  INVALID_QUESTION_TYPE: 'INVALID_QUESTION_TYPE',
  ANAMNESIS_ALREADY_LINKED: 'ANAMNESIS_ALREADY_LINKED',
  ANAMNESIS_HAS_STUDENT_LINKS: 'ANAMNESIS_HAS_STUDENT_LINKS',
  ANAMNESIS_RESPONSE_NOT_FOUND: 'ANAMNESIS_RESPONSE_NOT_FOUND',
  ANAMNESIS_NOT_LINKED_TO_STUDENT: 'ANAMNESIS_NOT_LINKED_TO_STUDENT',
  ANAMNESIS_RESPONSE_ALREADY_SUBMITTED: 'ANAMNESIS_RESPONSE_ALREADY_SUBMITTED',
  ANAMNESIS_RESPONSE_SUBMITTED_BY_STUDENT: 'ANAMNESIS_RESPONSE_SUBMITTED_BY_STUDENT',
  ANAMNESIS_RESPONSE_NOT_AWAITING_CONFIRMATION: 'ANAMNESIS_RESPONSE_NOT_AWAITING_CONFIRMATION',
  // Conditional questions
  INVALID_CONDITION: 'INVALID_CONDITION',
  PARENT_NOT_ELIGIBLE: 'PARENT_NOT_ELIGIBLE',
  PARENT_MUST_BE_SAME_SECTION: 'PARENT_MUST_BE_SAME_SECTION',
  PARENT_TYPE_LOCKED: 'PARENT_TYPE_LOCKED',
  CONDITION_REFERENCES_REMOVED_OPTION: 'CONDITION_REFERENCES_REMOVED_OPTION',
  CONDITIONAL_DEPTH_EXCEEDED: 'CONDITIONAL_DEPTH_EXCEEDED',
  // Dependency errors (trainer/student context within anamnesis flows)
  TRAINER_PROFILE_MISSING: 'TRAINER_PROFILE_MISSING',
  STUDENT_NOT_FOUND: 'STUDENT_NOT_FOUND',
});

export const AnamnesisMessageCode = Object.freeze({
  ANAMNESIS_NOT_FOUND: 'anamnesis.notFound',
  ANAMNESIS_SECTION_NOT_FOUND: 'anamnesis.section.notFound',
  ANAMNESIS_QUESTION_NOT_FOUND: 'anamnesis.question.notFound',
  FORBIDDEN_NOT_ANAMNESIS_OWNER: 'anamnesis.forbidden.notOwner',
  FORBIDDEN_GENERAL_ANAMNESIS: 'anamnesis.forbidden.general',
  INVALID_QUESTION_TYPE: 'anamnesis.invalidQuestionType',
  ANAMNESIS_ALREADY_LINKED: 'anamnesis.alreadyLinked',
  ANAMNESIS_HAS_STUDENT_LINKS: 'anamnesis.hasStudentLinks',
  ANAMNESIS_RESPONSE_NOT_FOUND: 'anamnesis.response.notFound',
  ANAMNESIS_NOT_LINKED_TO_STUDENT: 'anamnesis.notLinkedToStudent',
  ANAMNESIS_RESPONSE_ALREADY_SUBMITTED: 'anamnesis.response.alreadySubmitted',
  ANAMNESIS_RESPONSE_SUBMITTED_BY_STUDENT: 'anamnesis.response.submittedByStudent',
  ANAMNESIS_RESPONSE_NOT_AWAITING_CONFIRMATION: 'anamnesis.response.notAwaitingConfirmation',
  // Conditional questions
  INVALID_CONDITION: 'anamnesis.invalidCondition',
  PARENT_NOT_ELIGIBLE: 'anamnesis.parentNotEligible',
  PARENT_MUST_BE_SAME_SECTION: 'anamnesis.parentMustBeSameSection',
  PARENT_TYPE_LOCKED: 'anamnesis.parentTypeLocked',
  CONDITION_REFERENCES_REMOVED_OPTION: 'anamnesis.conditionReferencesRemovedOption',
  CONDITIONAL_DEPTH_EXCEEDED: 'anamnesis.conditionalDepthExceeded',
  // Dependency errors
  TRAINER_PROFILE_MISSING: 'trainer.notFound',
  STUDENT_NOT_FOUND: 'student.notFound',
});

/**
 * Validate a condition JSONB object against the parent question's type.
 * Throws AppError with INVALID_CONDITION if the condition is structurally invalid.
 * Throws AppError with PARENT_NOT_ELIGIBLE if the parent type cannot be a trigger.
 *
 * @param {{ type: string, options: Array<{ id: string }> }} parentQuestion
 * @param {object} condition
 */
export function validateCondition(parentQuestion, condition) {
  const { DICHOTOMOUS, SINGLE_CHOICE, MULTIPLE_CHOICE } = AnamnesisQuestionType;
  const { EQUALS, INCLUDES_ANY } = AnamnesisConditionOperator;

  if (!anamnesisParentEligibleTypes.includes(parentQuestion.type)) {
    throw new AppError({
      httpStatus: 400,
      error: AnamnesisErrorCode.PARENT_NOT_ELIGIBLE,
      messageCode: AnamnesisMessageCode.PARENT_NOT_ELIGIBLE,
      message: 'Only dichotomous, single choice, or multiple choice questions can be parent questions.',
    });
  }

  if (!condition || typeof condition !== 'object') {
    throw new AppError({
      httpStatus: 400,
      error: AnamnesisErrorCode.INVALID_CONDITION,
      messageCode: AnamnesisMessageCode.INVALID_CONDITION,
      message: 'Condition must be an object.',
    });
  }

  if (parentQuestion.type === DICHOTOMOUS) {
    if (condition.operator !== EQUALS) {
      throw new AppError({
        httpStatus: 400,
        error: AnamnesisErrorCode.INVALID_CONDITION,
        messageCode: AnamnesisMessageCode.INVALID_CONDITION,
        message: 'Dichotomous parent condition must use operator "equals".',
      });
    }
    if (condition.value !== 'yes' && condition.value !== 'no') {
      throw new AppError({
        httpStatus: 400,
        error: AnamnesisErrorCode.INVALID_CONDITION,
        messageCode: AnamnesisMessageCode.INVALID_CONDITION,
        message: 'Dichotomous parent condition value must be "yes" or "no".',
      });
    }
    return;
  }

  if (parentQuestion.type === SINGLE_CHOICE) {
    if (condition.operator !== EQUALS) {
      throw new AppError({
        httpStatus: 400,
        error: AnamnesisErrorCode.INVALID_CONDITION,
        messageCode: AnamnesisMessageCode.INVALID_CONDITION,
        message: 'Single choice parent condition must use operator "equals".',
      });
    }
    if (!condition.optionId || typeof condition.optionId !== 'string') {
      throw new AppError({
        httpStatus: 400,
        error: AnamnesisErrorCode.INVALID_CONDITION,
        messageCode: AnamnesisMessageCode.INVALID_CONDITION,
        message: 'Single choice parent condition must include a valid optionId.',
      });
    }
    const parentOptionIds = (parentQuestion.options ?? []).map((o) => o.id);
    if (!parentOptionIds.includes(condition.optionId)) {
      throw new AppError({
        httpStatus: 400,
        error: AnamnesisErrorCode.INVALID_CONDITION,
        messageCode: AnamnesisMessageCode.INVALID_CONDITION,
        message: 'condition.optionId does not belong to the parent question.',
      });
    }
    return;
  }

  if (parentQuestion.type === MULTIPLE_CHOICE) {
    if (condition.operator !== INCLUDES_ANY) {
      throw new AppError({
        httpStatus: 400,
        error: AnamnesisErrorCode.INVALID_CONDITION,
        messageCode: AnamnesisMessageCode.INVALID_CONDITION,
        message: 'Multiple choice parent condition must use operator "includesAny".',
      });
    }
    if (!Array.isArray(condition.optionIds) || condition.optionIds.length === 0) {
      throw new AppError({
        httpStatus: 400,
        error: AnamnesisErrorCode.INVALID_CONDITION,
        messageCode: AnamnesisMessageCode.INVALID_CONDITION,
        message: 'Multiple choice parent condition must include a non-empty optionIds array.',
      });
    }
    const parentOptionIds = new Set((parentQuestion.options ?? []).map((o) => o.id));
    const foreignId = condition.optionIds.find((id) => !parentOptionIds.has(id));
    if (foreignId) {
      throw new AppError({
        httpStatus: 400,
        error: AnamnesisErrorCode.INVALID_CONDITION,
        messageCode: AnamnesisMessageCode.INVALID_CONDITION,
        message: `condition.optionIds contains an ID that does not belong to the parent question: ${foreignId}`,
      });
    }
  }
}

/**
 * Determine whether a question should be visible given the current answers map.
 * Pure function — usable on both backend and frontend (no AppError dependency needed).
 *
 * @param {{ parentQuestionId: string|null, condition: object|null }} question
 * @param {Map<string, *>|Object} answersByQuestionId - keyed by questionId, value is the answer value
 * @returns {boolean}
 */
export function isQuestionVisible(question, answersByQuestionId) {
  if (!question.parentQuestionId || !question.condition) {
    return true;
  }

  const getAnswer = (id) => (
    answersByQuestionId instanceof Map
      ? answersByQuestionId.get(id)
      : answersByQuestionId[id]
  );

  const parentAnswer = getAnswer(question.parentQuestionId);

  // Parent hasn't been answered yet — child stays hidden
  if (parentAnswer === undefined || parentAnswer === null) {
    return false;
  }

  const { condition } = question;

  if (condition.operator === AnamnesisConditionOperator.EQUALS) {
    // Dichotomous: parentAnswer is 'yes' or 'no'
    if (condition.value !== undefined) {
      return parentAnswer === condition.value;
    }
    // Single choice: parentAnswer is an optionId string
    if (condition.optionId !== undefined) {
      return parentAnswer === condition.optionId;
    }
    return false;
  }

  if (condition.operator === AnamnesisConditionOperator.INCLUDES_ANY) {
    // Multiple choice: parentAnswer is an array of optionIds
    if (!Array.isArray(parentAnswer) || !Array.isArray(condition.optionIds)) {
      return false;
    }
    return condition.optionIds.some((id) => parentAnswer.includes(id));
  }

  return false;
}
