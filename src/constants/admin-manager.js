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
