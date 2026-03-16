/**
 * Anamnesis system constants
 * Used for validation and type safety across the anamnesis feature
 */

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
});
