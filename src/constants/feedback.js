export const FEEDBACK_CATEGORIES = Object.freeze({
  BUG: 'BUG',
  SUGGESTION: 'SUGGESTION',
  PRAISE: 'PRAISE',
});

export const FEEDBACK_STATUSES = Object.freeze({
  NEW: 'NEW',
  READ: 'READ',
});

export const FEEDBACK_ERROR_CODES = Object.freeze({
  NOT_FOUND: 'FEEDBACK_NOT_FOUND',
});

export const FEEDBACK_MESSAGE_CODES = Object.freeze({
  NOT_FOUND: 'resource.notFound',
  TRAINER_NOT_FOUND: 'trainer.notFound',
  VALIDATION_FAILED: 'validation.failed',
});

export const FEEDBACK_MESSAGE_MAX_LENGTH = 2000;
export const FEEDBACK_PAGE_PATH_MAX_LENGTH = 300;
export const FEEDBACK_VIEWPORT_MAX_LENGTH = 20;
export const FEEDBACK_USER_AGENT_MAX_LENGTH = 500;
export const FEEDBACK_DEFAULT_PAGE = 1;
export const FEEDBACK_DEFAULT_PAGE_SIZE = 20;
export const FEEDBACK_MAX_PAGE_SIZE = 100;
export const FEEDBACK_DEFAULT_TIER = 'FREE';
