export const LANGFUSE_CONTENT_MODES = Object.freeze({
  MASKED: 'masked',
  FULL: 'full',
  OFF: 'off',
})

export const LANGFUSE_DEFAULTS = Object.freeze({
  BASE_URL: 'https://cloud.langfuse.com',
  CONTENT_MODE: LANGFUSE_CONTENT_MODES.MASKED,
  // Small batches and a short interval keep the staging heap (320 MB) from holding spans.
  FLUSH_AT: 50,
  FLUSH_INTERVAL_SECONDS: 2,
  MAX_QUEUE_SIZE: 200,
  ENABLED_NODE_ENVS: Object.freeze(['staging', 'production']),
})

export const AI_TRACE = Object.freeze({
  ROOT_NAME: 'iarnold-turn',
  TAG_APP: 'iarnold',
  TAG_ABORTED: 'aborted',
  EVENT_GUARD_BLOCKED: 'guard-blocked',
  GENERATION_NAME: 'iarnold-generation',
  KIND_CHAT: 'chat',
  KIND_STREAM: 'stream',
  SHUTDOWN_TIMEOUT_MS: 5000,
  FLUSH_TIMEOUT_MS: 3000,
  STATUS_MESSAGE_MAX_CHARS: 500,
  ATTR_USER_ID: 'user.id',
  ATTR_SESSION_ID: 'session.id',
  ATTR_TAGS: 'langfuse.trace.tags',
  FIRST_GENERATION_REF: 'first-generation',
  CLIENT_ERROR_BELOW_STATUS: 500,
})

export const AI_TRACE_MASK = Object.freeze({
  FOCUS_PATTERN: /<dados_do_aluno_em_foco>[\s\S]*?<\/dados_do_aluno_em_foco>/g,
  EMAIL_PATTERN: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g,
  FOCUS_CAPTURE_PATTERN: /<dados_do_aluno_em_foco>([\s\S]*?)<\/dados_do_aluno_em_foco>/g,
  MIN_SECRET_CHARS: 8,
  FOCUS_PLACEHOLDER: '[redacted: student focus]',
  EMAIL_PLACEHOLDER: '[redacted: email]',
  UNMASKABLE: '[unmaskable]',
  ROSTER_BLOCK_PATTERN: /<dados_do_treinador>[\s\S]*?<\/dados_do_treinador>/g,
  ROSTER_HEADER: 'Alunos ativos:',
  ROSTER_LINE_PATTERN: /^- .* (\[REF:[^\]]+\])$/,
  ROSTER_NOTE_PATTERNS: [/^\(nenhum aluno ativo\)$/, /^\(Lista limitada/],
  PROTOCOL_ASSIGNEE_PATTERN: /( -> aluno: ).*?( \[PROTOCOL_REF:)/,
  NAME_PLACEHOLDER: '[redacted: name]',
  TRAINER_BLOCK_PLACEHOLDER: '[redacted: trainer data]',
})

export const LANGFUSE_USAGE_KEYS = Object.freeze({
  INPUT: 'input',
  OUTPUT: 'output',
  CACHE_READ: 'cache_read_input_tokens',
  CACHE_WRITE: 'cache_creation_input_tokens',
})
