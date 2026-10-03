export const PasswordResetErrorCode = Object.freeze({
  INVALID_CODE: 'PASSWORD_RESET_INVALID_CODE',
  EMAIL_REQUIRED: 'EMAIL_REQUIRED',
  CODE_REQUIRED: 'PASSWORD_RESET_CODE_REQUIRED',
  WEAK_PASSWORD: 'WEAK_PASSWORD',
  PASSWORD_MISMATCH: 'PASSWORD_MISMATCH',
});

export const PasswordResetMessageCode = Object.freeze({
  INVALID_CODE: 'passwordReset.invalidCode',
  EMAIL_REQUIRED: 'auth.email.required',
  CODE_REQUIRED: 'passwordReset.codeRequired',
  WEAK_PASSWORD: 'passwordReset.weakPassword',
  PASSWORD_MISMATCH: 'passwordReset.passwordMismatch',
});

export const PASSWORD_RESET_CODE_LENGTH = 6;
export const PASSWORD_RESET_TTL_MS = 15 * 60 * 1000;
export const PASSWORD_RESET_MAX_ATTEMPTS = 5;
export const PASSWORD_RESET_MIN_PASSWORD_LENGTH = 8;

// Issuance throttling window (rows older than this are purged on issue).
export const PASSWORD_RESET_ISSUE_WINDOW_MS = 60 * 60 * 1000;

// All-zero UUID: stands in for "no user" so the unknown-email path runs the
// same queries as the real one (uniform timing, uniform error).
export const NIL_UUID = '00000000-0000-0000-0000-000000000000';
