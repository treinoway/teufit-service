import { describe, it, expect } from 'vitest';
import ptBR from '../../src/i18n/locales/pt-BR.js';
import enUS from '../../src/i18n/locales/en-US.js';
import {
  StudentInviteStatus,
  StudentInviteOutcome,
  StudentInviteErrorCode,
  StudentInviteMessageCode,
  studentInviteStatusValues,
} from '../../src/constants/student-invite.js';

const EXPIRED_ERROR_CODE = 'STUDENT_INVITE_EXPIRED';
const EXPIRED_MESSAGE_CODE = 'studentInvite.expired';
const DECLINED_STATUS = 'declined';
const INVITE_STATUS_LABELS = 'inviteStatus';

const EXISTING_STATUSES = ['pending', 'accepted', 'revoked', 'expired'];
const EXISTING_OUTCOMES = ['linked', 'invited'];

const EXISTING_ERROR_CODES = [
  'STUDENT_INVITE_NOT_FOUND',
  'STUDENT_INVITE_NOT_PENDING',
  'STUDENT_INVITE_RESEND_COOLDOWN',
  'STUDENT_INVITE_RESEND_LIMIT',
  'STUDENT_INVITE_ALREADY_PENDING',
  'STUDENT_ACCOUNT_DEACTIVATED',
  'TRAINER_PROFILE_MISSING',
  'STUDENT_INVITE_DAILY_LIMIT',
  'STUDENT_INVITE_EMAIL_SEND_FAILED',
  'CANNOT_LINK_SELF',
];

const EXISTING_MESSAGE_CODES = [
  'studentInvite.notFound',
  'studentInvite.notPending',
  'studentInvite.resendCooldown',
  'studentInvite.resendLimit',
  'studentInvite.alreadyPending',
  'student.accountDeactivated',
  'trainer.notFound',
  'studentInvite.dailyLimit',
  'studentInvite.emailSendFailed',
  'student.cannotLinkSelf',
  'student.alreadyLinked',
];

describe('student invite consent constants and translations', () => {
  describe('constants', () => {
    it('should expose StudentInviteErrorCode.EXPIRED as STUDENT_INVITE_EXPIRED', () => {
      expect(StudentInviteErrorCode.EXPIRED).toBe(EXPIRED_ERROR_CODE);
    });

    it('should expose StudentInviteMessageCode.EXPIRED as studentInvite.expired', () => {
      expect(StudentInviteMessageCode.EXPIRED).toBe(EXPIRED_MESSAGE_CODE);
    });

    it('should expose StudentInviteStatus.DECLINED as declined', () => {
      expect(StudentInviteStatus.DECLINED).toBe(DECLINED_STATUS);
    });

    it('should accept declined as a status filter value', () => {
      expect(studentInviteStatusValues).toContain(DECLINED_STATUS);
    });

    it('should keep every pre-existing status', () => {
      expect(studentInviteStatusValues).toEqual(expect.arrayContaining(EXISTING_STATUSES));
    });

    it('should keep both outcomes in the contract, linked included', () => {
      expect(Object.values(StudentInviteOutcome)).toEqual(expect.arrayContaining(EXISTING_OUTCOMES));
    });

    it('should keep every pre-existing student invite error code unchanged', () => {
      expect(Object.values(StudentInviteErrorCode)).toEqual(expect.arrayContaining(EXISTING_ERROR_CODES));
    });

    it('should keep every pre-existing student invite messageCode unchanged', () => {
      expect(Object.values(StudentInviteMessageCode)).toEqual(expect.arrayContaining(EXISTING_MESSAGE_CODES));
    });
  });

  describe.each([
    ['pt-BR', ptBR],
    ['en-US', enUS],
  ])('%s locale', (_name, locale) => {
    it('should translate studentInvite.expired', () => {
      expect(locale.errors[EXPIRED_MESSAGE_CODE]).toEqual(expect.any(String));
      expect(locale.errors[EXPIRED_MESSAGE_CODE].trim().length).toBeGreaterThan(0);
    });

    it('should label the declined invite status', () => {
      expect(locale.categorical[INVITE_STATUS_LABELS][DECLINED_STATUS]).toEqual(expect.any(String));
    });
  });

  it('should have a distinct studentInvite.expired message per language', () => {
    expect(ptBR.errors[EXPIRED_MESSAGE_CODE]).toEqual(expect.any(String));
    expect(ptBR.errors[EXPIRED_MESSAGE_CODE]).not.toBe(enUS.errors[EXPIRED_MESSAGE_CODE]);
  });

  it('should tell the pt-BR user that the invite expired', () => {
    expect(ptBR.errors[EXPIRED_MESSAGE_CODE]).toMatch(/expir/i);
  });
});
