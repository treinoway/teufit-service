/**
 * AI Assistant constants
 * Used for the AI training assistant feature
 */

export const LLM_PROVIDERS = Object.freeze({
  ANTHROPIC: 'anthropic',
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
  REORDER_EXERCISES_IN_TRAINING: 'reorder_exercises_in_training',
  GET_STUDENT_PERFORMANCE: 'get_student_performance',
  SEARCH_EXERCISE_LIBRARY: 'search_exercise_library',
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
  UNAVAILABLE: 'AI_UNAVAILABLE',
  RESPONSE_TOO_LONG: 'AI_RESPONSE_TOO_LONG',
  TOOL_DISABLED: 'AI_TOOL_DISABLED',
  TIMEOUT: 'AI_TIMEOUT',
})

// Stable i18n keys for AI errors. Never change an existing value (client contract).
export const AI_MESSAGE_CODES = Object.freeze({
  TRAINER_NOT_FOUND: 'ai.trainerNotFound',
  CONVERSATION_NOT_FOUND: 'ai.conversationNotFound',
  RATE_LIMITED: 'ai.rateLimited',
  MODEL_ERROR: 'ai.modelError',
  OVERLOADED: 'ai.overloaded',
  EXERCISE_TEMPLATE_NOT_OWNED: 'ai.exerciseTemplateNotOwned',
  TRAINING_TEMPLATE_NOT_OWNED: 'ai.trainingTemplateNotOwned',
  UNAVAILABLE: 'ai.unavailable',
  RESPONSE_TOO_LONG: 'ai.responseTooLong',
  CONFIRMATION_REQUIRED: 'ai.confirmationRequired',
  TOOL_DISABLED: 'ai.toolDisabled',
  TIMEOUT: 'ai.timeout',
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
  MAX_CONTEXT_TRAININGS_PER_PROTOCOL: 10,
  MAX_CONTEXT_EXERCISES_PER_TRAINING: 20,
  // Character budget for the active-protocols block (~4 chars per token); the rest is cut with a note.
  MAX_CONTEXT_PROTOCOLS_CHARS: 40_000,
  // Student focus (anamnesis) limits, per studentId request.
  MAX_CONTEXT_ANAMNESIS_ANSWERS: 30,
  MAX_CONTEXT_ANAMNESIS_VALUE_CHARS: 200,
  MAX_CONTEXT_NAME_CHARS: 80,
  CONTEXT_PERFORMANCE_WINDOW_DAYS: 90,
  // why: Sonnet 5.5 thinks adaptively and thinking tokens count against max_tokens; 2500 truncated tool calls.
  MAX_TOKENS: 8000,
  // search_exercise_library: queries per call, chars kept per query, candidates returned per query.
  LIBRARY_SEARCH_MAX_QUERIES: 20,
  LIBRARY_SEARCH_MAX_QUERY_CHARS: 80,
  LIBRARY_SEARCH_MAX_RESULTS: 5,
  RATE_LIMIT_MAX: 10,
  RATE_LIMIT_WINDOW: '1 minute',
  // Upper bound for a single model call; SDK retries are disabled so withLlmRetry is the only retry layer.
  LLM_TIMEOUT_MS: 60_000,
})

export const AI_RETRY = Object.freeze({
  MAX_ATTEMPTS: 3,
  BASE_DELAY_MS: 1000,
  RETRYABLE_STATUSES: new Set([429, 500, 502, 503, 529]),
})

export const AI_MODELS = Object.freeze({
  ANTHROPIC: 'claude-sonnet-5-5',
})

// Timezone used for "today" in the prompt and for relative dates (trainers are in Brazil).
export const TRAINER_TIME_ZONE = 'America/Sao_Paulo'

export const AI_INTERACTION_LOG = Object.freeze({
  // Gate: set AI_INTERACTION_LOG_ENABLED=false in env to disable (default ON for beta)
  ENV_FLAG: 'AI_INTERACTION_LOG_ENABLED',
  STATUS_SUCCESS: 'success',
  STATUS_ERROR: 'error',
  // Truncate free-text fields to avoid unbounded row sizes.
  // userMessage/responseText may contain student PII — keep bounded.
  MAX_TEXT_LENGTH: 8000,
})
