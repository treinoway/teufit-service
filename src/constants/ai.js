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
  UPDATE_PROTOCOL_TEMPLATE: 'update_protocol_template',
  UPDATE_TRAINING_TEMPLATE: 'update_training_template',
  UPDATE_EXERCISE_TEMPLATE: 'update_exercise_template',
  UPDATE_PROTOCOL: 'update_protocol',
  UPDATE_TRAINING: 'update_training',
  UPDATE_EXERCISE: 'update_exercise',
  ADD_EXERCISES_TO_TRAINING: 'add_exercises_to_training',
})

export const AI_ERRORS = Object.freeze({
  CONTEXT_BUILD_FAILED: 'AI_CONTEXT_BUILD_FAILED',
  TOOL_EXECUTION_FAILED: 'AI_TOOL_EXECUTION_FAILED',
  MODEL_ERROR: 'AI_MODEL_ERROR',
  CONVERSATION_NOT_FOUND: 'AI_CONVERSATION_NOT_FOUND',
  RATE_LIMITED: 'AI_RATE_LIMITED',
  OVERLOADED: 'AI_OVERLOADED',
  EXERCISE_TEMPLATE_NOT_OWNED: 'AI_EXERCISE_TEMPLATE_NOT_OWNED',
  TRAINING_TEMPLATE_NOT_OWNED: 'AI_TRAINING_TEMPLATE_NOT_OWNED',
})

export const AI_LIMITS = Object.freeze({
  MAX_HISTORY_ITEMS: 10,
  MAX_MESSAGE_LENGTH: 5000,
  MAX_CONTEXT_ITEMS: 50,
  MAX_CONTEXT_STUDENTS: 50,
  MAX_CONTEXT_PROTOCOL_TEMPLATES: 20,
  MAX_CONTEXT_TRAINING_TEMPLATES: 30,
  MAX_CONTEXT_ACTIVE_PROTOCOLS: 30,
  MAX_CONTEXT_EXERCISE_TEMPLATES: 20,
  MAX_CONTEXT_TRAININGS_PER_PROTOCOL: 6,
  MAX_CONTEXT_EXERCISES_PER_TRAINING: 6,
  MAX_TOKENS: 2500,
  RATE_LIMIT_MAX: 10,
  RATE_LIMIT_WINDOW: '1 minute',
})

export const AI_RETRY = Object.freeze({
  MAX_ATTEMPTS: 3,
  BASE_DELAY_MS: 1000,
  RETRYABLE_STATUSES: new Set([429, 500, 502, 503, 529]),
})

export const AI_MODELS = Object.freeze({
  ANTHROPIC: 'claude-sonnet-4-6',
  GEMINI: 'gemini-2.5-flash',
})
