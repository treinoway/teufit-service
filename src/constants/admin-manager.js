export const ADMIN_MANAGER_USER_KIND = Object.freeze({
  TRAINER: 'trainer',
  STUDENT: 'student',
  ADMIN: 'admin',
  NUTRITIONIST: 'nutritionist',
});

export const ADMIN_MANAGER_PROTOCOL_PERSPECTIVE = Object.freeze({
  TRAINER: 'trainer',
  STUDENT: 'student',
});

export const ADMIN_MANAGER_TEMPLATE_TYPE = Object.freeze({
  TRAINING: 'training',
  EXERCISE: 'exercise',
});

export const AdminManagerMessageCode = Object.freeze({
  QUERY_TIMEOUT: 'admin.queryTimeout',
  USER_NOT_FOUND: 'admin.userNotFound',
  PROTOCOL_NOT_FOUND: 'admin.protocolNotFound',
  SESSION_NOT_FOUND: 'admin.sessionNotFound',
});

export const ADMIN_MANAGER_PAGE_SIZE_DEFAULT = 20;
export const ADMIN_MANAGER_PAGE_SIZE_MAX = 50;
export const ADMIN_MANAGER_SEARCH_MAX_LENGTH = 200;
export const POSTGRES_STATEMENT_TIMEOUT_CODE = '57014';
export const ADMIN_MANAGER_ERROR_UNAVAILABLE = 'SERVICE_UNAVAILABLE';

export const OVERVIEW_PERIODS = Object.freeze({
  DAYS_7: '7d',
  DAYS_30: '30d',
  DAYS_90: '90d',
});

export const OVERVIEW_PERIOD_DAYS = Object.freeze({
  [OVERVIEW_PERIODS.DAYS_7]: 7,
  [OVERVIEW_PERIODS.DAYS_30]: 30,
  [OVERVIEW_PERIODS.DAYS_90]: 90,
});

export const OVERVIEW_DEFAULT_PERIOD = OVERVIEW_PERIODS.DAYS_30;
export const OVERVIEW_WEEKLY_BUCKETS = 8;
export const OVERVIEW_TOP_AI_TRAINERS_LIMIT = 5;
export const OVERVIEW_LATEST_TRAINERS_LIMIT = 5;
export const OVERVIEW_NO_STUDENT_THRESHOLD_DAYS = 14;
