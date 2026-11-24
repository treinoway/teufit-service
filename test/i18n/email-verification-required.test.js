import { describe, it, expect } from 'vitest';
import ptBR from '../../src/i18n/locales/pt-BR.js';
import enUS from '../../src/i18n/locales/en-US.js';
import { EmailVerificationErrorCode, EmailVerificationMessageCode } from '../../src/constants/email-verification.js';

const REQUIRED_ERROR_CODE = 'EMAIL_VERIFICATION_REQUIRED';
const REQUIRED_MESSAGE_CODE = 'emailVerification.required';

const EXISTING_ERROR_CODES = [
  'EMAIL_VERIFICATION_INVALID_CODE',
  'EMAIL_VERIFICATION_CODE_EXPIRED',
  'EMAIL_VERIFICATION_TOO_MANY_ATTEMPTS',
  'EMAIL_ALREADY_VERIFIED',
  'EMAIL_VERIFICATION_RESEND_COOLDOWN',
  'EMAIL_VERIFICATION_USER_NOT_FOUND',
  'EMAIL_VERIFICATION_DAILY_LIMIT',
  'EMAIL_VERIFICATION_SEND_FAILED',
];

const EXISTING_MESSAGE_CODES = [
  'emailVerification.invalidCode',
  'emailVerification.codeExpired',
  'emailVerification.tooManyAttempts',
  'emailVerification.alreadyVerified',
  'emailVerification.resendCooldown',
  'emailVerification.userNotFound',
  'emailVerification.dailyLimit',
  'emailVerification.sendFailed',
];

describe('emailVerification.required error code', () => {
  describe('constants', () => {
    it('should expose the EMAIL_VERIFICATION_REQUIRED error code', () => {
      expect(Object.values(EmailVerificationErrorCode)).toContain(REQUIRED_ERROR_CODE);
    });

    it('should expose the emailVerification.required messageCode', () => {
      expect(Object.values(EmailVerificationMessageCode)).toContain(REQUIRED_MESSAGE_CODE);
    });

    it('should keep every pre-existing email verification error code unchanged', () => {
      expect(Object.values(EmailVerificationErrorCode)).toEqual(expect.arrayContaining(EXISTING_ERROR_CODES));
    });

    it('should keep every pre-existing email verification messageCode unchanged', () => {
      expect(Object.values(EmailVerificationMessageCode)).toEqual(expect.arrayContaining(EXISTING_MESSAGE_CODES));
    });
  });

  describe.each([
    ['pt-BR', ptBR],
    ['en-US', enUS],
  ])('%s locale', (_name, locale) => {
    it('should translate emailVerification.required', () => {
      expect(locale.errors[REQUIRED_MESSAGE_CODE]).toEqual(expect.any(String));
      expect(locale.errors[REQUIRED_MESSAGE_CODE].trim().length).toBeGreaterThan(0);
    });
  });

  it('should have a distinct message per language', () => {
    expect(ptBR.errors[REQUIRED_MESSAGE_CODE]).toEqual(expect.any(String));
    expect(ptBR.errors[REQUIRED_MESSAGE_CODE]).not.toBe(enUS.errors[REQUIRED_MESSAGE_CODE]);
  });

  it('should tell the pt-BR user to confirm the e-mail', () => {
    expect(ptBR.errors[REQUIRED_MESSAGE_CODE]).toMatch(/e-mail/i);
  });
});
