export const EmailVerificationErrorCode = Object.freeze({
  INVALID_CODE: 'EMAIL_VERIFICATION_INVALID_CODE',
  CODE_EXPIRED: 'EMAIL_VERIFICATION_CODE_EXPIRED',
  TOO_MANY_ATTEMPTS: 'EMAIL_VERIFICATION_TOO_MANY_ATTEMPTS',
  ALREADY_VERIFIED: 'EMAIL_ALREADY_VERIFIED',
  RESEND_COOLDOWN: 'EMAIL_VERIFICATION_RESEND_COOLDOWN',
  USER_NOT_FOUND: 'EMAIL_VERIFICATION_USER_NOT_FOUND',
  DAILY_LIMIT: 'EMAIL_VERIFICATION_DAILY_LIMIT',
  SEND_FAILED: 'EMAIL_VERIFICATION_SEND_FAILED',
});

export const EmailVerificationMessageCode = Object.freeze({
  INVALID_CODE: 'emailVerification.invalidCode',
  CODE_EXPIRED: 'emailVerification.codeExpired',
  TOO_MANY_ATTEMPTS: 'emailVerification.tooManyAttempts',
  ALREADY_VERIFIED: 'emailVerification.alreadyVerified',
  RESEND_COOLDOWN: 'emailVerification.resendCooldown',
  USER_NOT_FOUND: 'emailVerification.userNotFound',
  DAILY_LIMIT: 'emailVerification.dailyLimit',
  SEND_FAILED: 'emailVerification.sendFailed',
});

export const EMAIL_PROVIDER = 'email';

export const EMAIL_VERIFICATION_CODE_LENGTH = 6;
export const EMAIL_VERIFICATION_TTL_MS = 30 * 60 * 1000;
export const EMAIL_VERIFICATION_MAX_ATTEMPTS = 5;
export const EMAIL_VERIFICATION_RESEND_COOLDOWN_MS = 60 * 1000;

// Per-user cap on issued codes (counted over email_verification_tokens.created_at).
// Bounds total guesses to MAX_CODES * MAX_ATTEMPTS per window regardless of IP.
export const EMAIL_VERIFICATION_DAILY_MAX_CODES = 5;
export const EMAIL_VERIFICATION_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
