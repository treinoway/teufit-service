/**
 * AI Assistant constants
 * Used for the AI training assistant feature
 */

export const LLM_PROVIDERS = Object.freeze({
  ANTHROPIC: 'anthropic',
  GEMINI: 'gemini',
})

export const AI_TOOLS = Object.freeze({
  IMPORT_FROM_TEMPLATE: 'import_from_template',
  ADD_TRAINING_TO_PROTOCOL: 'add_training_to_protocol',
  CREATE_EXERCISE_TEMPLATE: 'create_exercise_template',
  CREATE_TRAINING_TEMPLATE: 'create_training_template',
  CREATE_PROTOCOL_TEMPLATE: 'create_protocol_template',
})

export const AI_ERRORS = Object.freeze({
  CONTEXT_BUILD_FAILED: 'AI_CONTEXT_BUILD_FAILED',
  TOOL_EXECUTION_FAILED: 'AI_TOOL_EXECUTION_FAILED',
  MODEL_ERROR: 'AI_MODEL_ERROR',
  CONVERSATION_NOT_FOUND: 'AI_CONVERSATION_NOT_FOUND',
  RATE_LIMITED: 'AI_RATE_LIMITED',
  OVERLOADED: 'AI_OVERLOADED',
})

export const AI_LIMITS = Object.freeze({
  MAX_HISTORY_ITEMS: 20,
  MAX_MESSAGE_LENGTH: 5000,
  MAX_CONTEXT_ITEMS: 50,
  RATE_LIMIT_MAX: 10,
  RATE_LIMIT_WINDOW: '1 minute',
})

export const AI_RETRY = Object.freeze({
  MAX_ATTEMPTS: 3,
  BASE_DELAY_MS: 1000,
  RETRYABLE_STATUSES: new Set([429, 500, 502, 503, 529]),
})
