import crypto from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/config/email-handler.js', () => ({
  default: { sendEmailVerificationEmail: vi.fn() },
}));
vi.mock('../../src/services/student-invite-service.js', () => ({
  acceptPendingInvitesForUser: vi.fn(),
}));

import emailHandler from '../../src/config/email-handler.js';
import { acceptPendingInvitesForUser } from '../../src/services/student-invite-service.js';
import {
  EmailVerificationErrorCode,
  EmailVerificationMessageCode,
  EMAIL_PROVIDER,
  EMAIL_VERIFICATION_CODE_LENGTH,
  EMAIL_VERIFICATION_TTL_MS,
  EMAIL_VERIFICATION_MAX_ATTEMPTS,
  EMAIL_VERIFICATION_RESEND_COOLDOWN_MS,
  EMAIL_VERIFICATION_DAILY_MAX_CODES,
  EMAIL_VERIFICATION_DAILY_WINDOW_MS,
} from '../../src/constants/email-verification.js';
import {
  isUserEmailVerified,
  sendVerificationCodeSafely,
  verifyEmailCode,
  resendVerificationCode,
  issueCodeRespectingLimits,
  markVerificationSendFailed,
  confirmVerificationCodeDelivered,
  markEmailVerifiedFromInboxProof,
} from '../../src/services/email-verification-service.js';

const USER_ID = 'user-1';
const USER_EMAIL = 'student@example.com';
const NEW_TOKEN_ID = 'token-new';
const NOW = new Date('2026-09-29T12:00:00.000Z');
const CORRECT_CODE = '123456';
const WRONG_CODE = '654321';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function makePrisma() {
  const prisma = {
    user: { findUnique: vi.fn() },
    account: { findFirst: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
    emailVerificationToken: {
      updateMany: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
  };
  prisma.$transaction = vi.fn(async (ops) => Promise.all(ops));
  return prisma;
}

function makeToken(overrides = {}) {
  return {
    id: 'token-1',
    userId: USER_ID,
    tokenHash: sha256(CORRECT_CODE),
    used: false,
    attempts: 0,
    expiresAt: new Date(NOW.getTime() + EMAIL_VERIFICATION_TTL_MS),
    createdAt: NOW,
    ...overrides,
  };
}

describe('email-verification-service', () => {
  let prisma;
  let emailSender;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    prisma = makePrisma();
    emailSender = { sendEmailVerificationEmail: vi.fn().mockResolvedValue(undefined) };
    prisma.user.findUnique.mockResolvedValue({ id: USER_ID, email: USER_EMAIL, deletedAt: null });
    prisma.account.findFirst.mockResolvedValue(null);
    prisma.account.updateMany.mockResolvedValue({ count: 1 });
    prisma.emailVerificationToken.updateMany.mockResolvedValue({ count: 1 });
    prisma.emailVerificationToken.create.mockResolvedValue({ id: NEW_TOKEN_ID, createdAt: NOW });
    prisma.emailVerificationToken.findFirst.mockResolvedValue(makeToken());
    prisma.emailVerificationToken.findMany.mockResolvedValue([]);
    acceptPendingInvitesForUser.mockResolvedValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('isUserEmailVerified', () => {
    it('should return true when any account has verifiedAt', async () => {
      prisma.account.findFirst.mockResolvedValue({ id: 'acc-1' });

      await expect(isUserEmailVerified(prisma, USER_ID)).resolves.toBe(true);
      expect(prisma.account.findFirst).toHaveBeenCalledWith({
        where: { userId: USER_ID, verifiedAt: { not: null } },
        select: { id: true },
      });
    });

    it('should return false when no account is verified', async () => {
      await expect(isUserEmailVerified(prisma, USER_ID)).resolves.toBe(false);
    });
  });

  describe('sendVerificationCodeSafely', () => {
    it('should store only a sha256 hash of a 6-digit code and not close prior codes up front', async () => {
      await sendVerificationCodeSafely(prisma, { userId: USER_ID, email: USER_EMAIL }, { emailSender });

      const { code } = emailSender.sendEmailVerificationEmail.mock.calls[0][0];
      expect(code).toMatch(new RegExp(`^\\d{${EMAIL_VERIFICATION_CODE_LENGTH}}$`));
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.emailVerificationToken.create).toHaveBeenCalledWith({
        data: {
          tokenHash: sha256(code),
          userId: USER_ID,
          expiresAt: new Date(NOW.getTime() + EMAIL_VERIFICATION_TTL_MS),
        },
        select: { id: true, createdAt: true },
      });
    });

    it('should close only strictly older codes after the email is delivered', async () => {
      await sendVerificationCodeSafely(prisma, { userId: USER_ID, email: USER_EMAIL }, { emailSender });

      expect(prisma.emailVerificationToken.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.emailVerificationToken.updateMany).toHaveBeenCalledWith({
        where: {
          userId: USER_ID,
          used: false,
          sendFailedAt: null,
          id: { not: NEW_TOKEN_ID },
          createdAt: { lt: NOW },
        },
        data: { used: true },
      });
    });

    it.each([
      ['a thrown error', (fn) => fn.mockRejectedValue(new Error('resend down'))],
      ['a returned Resend error', (fn) => fn.mockResolvedValue({ data: null, error: { message: 'rejected' } })],
    ])('should leave the previous code untouched (no close call) on %s', async (_label, arrange) => {
      arrange(emailSender.sendEmailVerificationEmail);

      await sendVerificationCodeSafely(prisma, { userId: USER_ID, email: USER_EMAIL }, { emailSender });

      const closeCalls = prisma.emailVerificationToken.updateMany.mock.calls.filter(
        ([arg]) => arg.where.createdAt !== undefined,
      );
      expect(closeCalls).toHaveLength(0);
    });

    it('should never persist the plaintext code', async () => {
      await sendVerificationCodeSafely(prisma, { userId: USER_ID, email: USER_EMAIL }, { emailSender });

      const { code } = emailSender.sendEmailVerificationEmail.mock.calls[0][0];
      const { data } = prisma.emailVerificationToken.create.mock.calls[0][0];
      expect(JSON.stringify(data)).not.toContain(`"${code}"`);
    });

    it('should email the code to the given address', async () => {
      await sendVerificationCodeSafely(prisma, { userId: USER_ID, email: USER_EMAIL }, { emailSender });

      expect(emailSender.sendEmailVerificationEmail).toHaveBeenCalledWith({
        to: USER_EMAIL,
        code: expect.any(String),
      });
    });

    it('should default to the shared emailHandler', async () => {
      await sendVerificationCodeSafely(prisma, { userId: USER_ID, email: USER_EMAIL });

      expect(emailHandler.sendEmailVerificationEmail).toHaveBeenCalledTimes(1);
    });

    it('should not throw when email delivery fails', async () => {
      emailSender.sendEmailVerificationEmail.mockRejectedValue(new Error('resend down'));

      await expect(
        sendVerificationCodeSafely(prisma, { userId: USER_ID, email: USER_EMAIL }, { emailSender }),
      ).resolves.toBeUndefined();
      expect(console.error).toHaveBeenCalled();
    });

    it('should log and not throw when Resend returns an error instead of throwing', async () => {
      const resendError = { message: 'invalid recipient' };
      emailSender.sendEmailVerificationEmail.mockResolvedValue({ data: null, error: resendError });

      await expect(
        sendVerificationCodeSafely(prisma, { userId: USER_ID, email: USER_EMAIL }, { emailSender }),
      ).resolves.toBeUndefined();
      expect(console.error).toHaveBeenCalledWith('Failed to send email verification code', resendError);
    });

    it.each([
      ['a thrown error', (fn) => fn.mockRejectedValue(new Error('resend down'))],
      ['a returned Resend error', (fn) => fn.mockResolvedValue({ data: null, error: { message: 'rejected' } })],
    ])('should mark the issued code row as undelivered on %s', async (_label, arrange) => {
      arrange(emailSender.sendEmailVerificationEmail);

      await sendVerificationCodeSafely(prisma, { userId: USER_ID, email: USER_EMAIL }, { emailSender });

      expect(prisma.emailVerificationToken.updateMany).toHaveBeenLastCalledWith({
        where: { id: NEW_TOKEN_ID },
        data: { used: true, sendFailedAt: NOW },
      });
    });

    it('should not mark the row undelivered when delivery succeeds', async () => {
      await sendVerificationCodeSafely(prisma, { userId: USER_ID, email: USER_EMAIL }, { emailSender });

      expect(prisma.emailVerificationToken.updateMany).toHaveBeenCalledTimes(1);
    });

    it('should not throw, issue a code or send an email when over the daily cap', async () => {
      prisma.emailVerificationToken.findMany.mockResolvedValue(
        Array.from({ length: EMAIL_VERIFICATION_DAILY_MAX_CODES }, (_, i) => ({
          createdAt: new Date(NOW.getTime() - (i + 1) * 60_000),
        })),
      );

      await expect(
        sendVerificationCodeSafely(prisma, { userId: USER_ID, email: USER_EMAIL }, { emailSender }),
      ).resolves.toBeUndefined();
      expect(prisma.emailVerificationToken.create).not.toHaveBeenCalled();
      expect(emailSender.sendEmailVerificationEmail).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalled();
    });

    it('should not throw when persisting the token fails, and should not send an email', async () => {
      prisma.emailVerificationToken.create.mockRejectedValue(new Error('db down'));

      await expect(
        sendVerificationCodeSafely(prisma, { userId: USER_ID, email: USER_EMAIL }, { emailSender }),
      ).resolves.toBeUndefined();
      expect(emailSender.sendEmailVerificationEmail).not.toHaveBeenCalled();
    });
  });

  describe('issueCodeRespectingLimits', () => {
    it('should return the plaintext code, token id, user id and createdAt', async () => {
      prisma.emailVerificationToken.findFirst.mockResolvedValue(null);

      const issued = await issueCodeRespectingLimits(prisma, USER_ID);

      expect(issued).toEqual({
        code: expect.stringMatching(/^\d{6}$/),
        tokenId: NEW_TOKEN_ID,
        userId: USER_ID,
        createdAt: NOW,
      });
    });

    it('should not close any previous code while issuing', async () => {
      prisma.emailVerificationToken.findFirst.mockResolvedValue(null);

      await issueCodeRespectingLimits(prisma, USER_ID);

      expect(prisma.emailVerificationToken.updateMany).not.toHaveBeenCalled();
    });

    it('should throw 429 resendCooldown without issuing when a delivered code is recent', async () => {
      prisma.emailVerificationToken.findFirst.mockResolvedValue({ createdAt: NOW });

      await expect(issueCodeRespectingLimits(prisma, USER_ID)).rejects.toMatchObject({
        httpStatus: 429,
        messageCode: EmailVerificationMessageCode.RESEND_COOLDOWN,
      });
      expect(prisma.emailVerificationToken.create).not.toHaveBeenCalled();
    });

    it('should throw 429 dailyLimit without issuing when the cap is reached', async () => {
      prisma.emailVerificationToken.findFirst.mockResolvedValue(null);
      prisma.emailVerificationToken.findMany.mockResolvedValue(
        Array.from({ length: EMAIL_VERIFICATION_DAILY_MAX_CODES }, (_, i) => ({
          createdAt: new Date(NOW.getTime() - (i + 1) * 60_000),
        })),
      );

      await expect(issueCodeRespectingLimits(prisma, USER_ID)).rejects.toMatchObject({
        httpStatus: 429,
        messageCode: EmailVerificationMessageCode.DAILY_LIMIT,
      });
      expect(prisma.emailVerificationToken.create).not.toHaveBeenCalled();
    });
  });

  describe('confirmVerificationCodeDelivered', () => {
    const issued = { tokenId: NEW_TOKEN_ID, userId: USER_ID, createdAt: NOW };

    it('should close only unused, non-failed rows strictly older than the delivered one', async () => {
      await confirmVerificationCodeDelivered(prisma, issued);

      expect(prisma.emailVerificationToken.updateMany).toHaveBeenCalledWith({
        where: {
          userId: USER_ID,
          used: false,
          sendFailedAt: null,
          id: { not: NEW_TOKEN_ID },
          createdAt: { lt: NOW },
        },
        data: { used: true },
      });
    });

    it('should never throw when closing fails', async () => {
      prisma.emailVerificationToken.updateMany.mockRejectedValue(new Error('db down'));

      await expect(confirmVerificationCodeDelivered(prisma, issued)).resolves.toBeUndefined();
      expect(console.error).toHaveBeenCalled();
    });
  });

  describe('markEmailVerifiedFromInboxProof', () => {
    const user = { id: USER_ID, email: 'Student@Example.com' };

    it('should verify the unverified email account and accept pending invites on the transition', async () => {
      prisma.account.updateMany.mockResolvedValue({ count: 1 });

      await expect(markEmailVerifiedFromInboxProof(prisma, user)).resolves.toBe(true);

      expect(prisma.account.updateMany).toHaveBeenCalledWith({
        where: { userId: USER_ID, provider: EMAIL_PROVIDER, verifiedAt: null },
        data: { verifiedAt: NOW },
      });
      expect(prisma.account.create).not.toHaveBeenCalled();
      expect(acceptPendingInvitesForUser).toHaveBeenCalledWith(prisma, user);
    });

    it('should do nothing and not accept invites when the email account is already verified', async () => {
      prisma.account.updateMany.mockResolvedValue({ count: 0 });
      prisma.account.findFirst.mockResolvedValue({ id: 'acc-email' });

      await expect(markEmailVerifiedFromInboxProof(prisma, user)).resolves.toBe(false);

      expect(prisma.account.create).not.toHaveBeenCalled();
      expect(acceptPendingInvitesForUser).not.toHaveBeenCalled();
    });

    it('should create an already-verified email account with a lowercased providerId when the user has none', async () => {
      prisma.account.updateMany.mockResolvedValue({ count: 0 });
      prisma.account.findFirst.mockResolvedValue(null);

      await expect(markEmailVerifiedFromInboxProof(prisma, user)).resolves.toBe(true);

      expect(prisma.account.findFirst).toHaveBeenCalledWith({
        where: { userId: USER_ID, provider: EMAIL_PROVIDER },
        select: { id: true },
      });
      expect(prisma.account.create).toHaveBeenCalledWith({
        data: { userId: USER_ID, provider: EMAIL_PROVIDER, providerId: 'student@example.com', verifiedAt: NOW },
      });
      expect(acceptPendingInvitesForUser).toHaveBeenCalledWith(prisma, user);
    });

    it('should never throw when the database fails, returning false', async () => {
      prisma.account.updateMany.mockRejectedValue(new Error('db down'));

      await expect(markEmailVerifiedFromInboxProof(prisma, user)).resolves.toBe(false);
      expect(console.error).toHaveBeenCalled();
      expect(acceptPendingInvitesForUser).not.toHaveBeenCalled();
    });

    it('should never throw when accepting invites fails', async () => {
      prisma.account.updateMany.mockResolvedValue({ count: 1 });
      acceptPendingInvitesForUser.mockRejectedValue(new Error('boom'));

      await expect(markEmailVerifiedFromInboxProof(prisma, user)).resolves.toBe(false);
    });
  });

  describe('markVerificationSendFailed', () => {
    it('should close the row and stamp sendFailedAt', async () => {
      await markVerificationSendFailed(prisma, NEW_TOKEN_ID);

      expect(prisma.emailVerificationToken.updateMany).toHaveBeenCalledWith({
        where: { id: NEW_TOKEN_ID },
        data: { used: true, sendFailedAt: NOW },
      });
    });

    it('should never throw when the update fails', async () => {
      prisma.emailVerificationToken.updateMany.mockRejectedValue(new Error('db down'));

      await expect(markVerificationSendFailed(prisma, NEW_TOKEN_ID)).resolves.toBeUndefined();
      expect(console.error).toHaveBeenCalled();
    });
  });

  describe('verifyEmailCode', () => {
    it('should verify, mark the email account verified and return the linked trainer count', async () => {
      acceptPendingInvitesForUser.mockResolvedValue(2);

      const result = await verifyEmailCode(prisma, { userId: USER_ID, code: CORRECT_CODE });

      expect(result).toEqual({ verified: true, linkedTrainers: 2 });
      expect(prisma.account.updateMany).toHaveBeenCalledWith({
        where: { userId: USER_ID, provider: EMAIL_PROVIDER, verifiedAt: null },
        data: { verifiedAt: NOW },
      });
      expect(acceptPendingInvitesForUser).toHaveBeenCalledWith(prisma, {
        id: USER_ID,
        email: USER_EMAIL,
        deletedAt: null,
      });
    });

    it('should consume an attempt atomically and burn the token on success', async () => {
      await verifyEmailCode(prisma, { userId: USER_ID, code: CORRECT_CODE });

      expect(prisma.emailVerificationToken.updateMany).toHaveBeenNthCalledWith(1, {
        where: { id: 'token-1', used: false, attempts: { lt: EMAIL_VERIFICATION_MAX_ATTEMPTS } },
        data: { attempts: { increment: 1 } },
      });
      expect(prisma.emailVerificationToken.updateMany).toHaveBeenNthCalledWith(2, {
        where: { id: 'token-1', used: false },
        data: { used: true },
      });
    });

    it('should look up the newest unused token', async () => {
      await verifyEmailCode(prisma, { userId: USER_ID, code: CORRECT_CODE });

      expect(prisma.emailVerificationToken.findFirst).toHaveBeenCalledWith({
        where: { userId: USER_ID, used: false, sendFailedAt: null },
        orderBy: { createdAt: 'desc' },
      });
    });

    it('should throw 400 invalidCode when only undelivered codes remain (no active token)', async () => {
      prisma.emailVerificationToken.findFirst.mockResolvedValue(null);

      await expect(verifyEmailCode(prisma, { userId: USER_ID, code: CORRECT_CODE })).rejects.toMatchObject({
        httpStatus: 400,
        messageCode: EmailVerificationMessageCode.INVALID_CODE,
      });
    });

    it('should accept a code with surrounding whitespace', async () => {
      await expect(verifyEmailCode(prisma, { userId: USER_ID, code: ` ${CORRECT_CODE} ` })).resolves.toMatchObject({
        verified: true,
      });
    });

    it('should throw 400 invalidCode for a wrong code, without verifying or burning the token', async () => {
      await expect(verifyEmailCode(prisma, { userId: USER_ID, code: WRONG_CODE })).rejects.toMatchObject({
        httpStatus: 400,
        error: EmailVerificationErrorCode.INVALID_CODE,
        messageCode: EmailVerificationMessageCode.INVALID_CODE,
      });
      expect(prisma.emailVerificationToken.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.account.updateMany).not.toHaveBeenCalled();
      expect(acceptPendingInvitesForUser).not.toHaveBeenCalled();
    });

    it('should throw 400 invalidCode when no active token exists', async () => {
      prisma.emailVerificationToken.findFirst.mockResolvedValue(null);

      await expect(verifyEmailCode(prisma, { userId: USER_ID, code: CORRECT_CODE })).rejects.toMatchObject({
        httpStatus: 400,
        messageCode: EmailVerificationMessageCode.INVALID_CODE,
      });
    });

    it('should throw 400 codeExpired when the token is past its TTL, without consuming an attempt', async () => {
      prisma.emailVerificationToken.findFirst.mockResolvedValue(
        makeToken({ expiresAt: new Date(NOW.getTime() - 1) }),
      );

      await expect(verifyEmailCode(prisma, { userId: USER_ID, code: CORRECT_CODE })).rejects.toMatchObject({
        httpStatus: 400,
        error: EmailVerificationErrorCode.CODE_EXPIRED,
        messageCode: EmailVerificationMessageCode.CODE_EXPIRED,
      });
      expect(prisma.emailVerificationToken.updateMany).not.toHaveBeenCalled();
    });

    it('should throw 429 tooManyAttempts when the atomic increment matches nothing (cap reached)', async () => {
      prisma.emailVerificationToken.findFirst.mockResolvedValue(
        makeToken({ attempts: EMAIL_VERIFICATION_MAX_ATTEMPTS }),
      );
      prisma.emailVerificationToken.updateMany.mockResolvedValue({ count: 0 });

      await expect(verifyEmailCode(prisma, { userId: USER_ID, code: CORRECT_CODE })).rejects.toMatchObject({
        httpStatus: 429,
        error: EmailVerificationErrorCode.TOO_MANY_ATTEMPTS,
        messageCode: EmailVerificationMessageCode.TOO_MANY_ATTEMPTS,
      });
      expect(acceptPendingInvitesForUser).not.toHaveBeenCalled();
    });

    it('should reject even the correct code once attempts are exhausted', async () => {
      prisma.emailVerificationToken.updateMany.mockResolvedValue({ count: 0 });

      await expect(verifyEmailCode(prisma, { userId: USER_ID, code: CORRECT_CODE })).rejects.toMatchObject({
        messageCode: EmailVerificationMessageCode.TOO_MANY_ATTEMPTS,
      });
      expect(prisma.account.updateMany).not.toHaveBeenCalled();
    });

    it('should throw 400 invalidCode when the token was consumed concurrently (used update count 0)', async () => {
      prisma.emailVerificationToken.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });

      await expect(verifyEmailCode(prisma, { userId: USER_ID, code: CORRECT_CODE })).rejects.toMatchObject({
        messageCode: EmailVerificationMessageCode.INVALID_CODE,
      });
      expect(prisma.account.updateMany).not.toHaveBeenCalled();
    });

    it('should throw 409 alreadyVerified when an account is already verified', async () => {
      prisma.account.findFirst.mockResolvedValue({ id: 'acc-1' });

      await expect(verifyEmailCode(prisma, { userId: USER_ID, code: CORRECT_CODE })).rejects.toMatchObject({
        httpStatus: 409,
        error: EmailVerificationErrorCode.ALREADY_VERIFIED,
        messageCode: EmailVerificationMessageCode.ALREADY_VERIFIED,
      });
      expect(prisma.emailVerificationToken.findFirst).not.toHaveBeenCalled();
    });

    it('should throw 404 userNotFound when the user does not exist', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(verifyEmailCode(prisma, { userId: USER_ID, code: CORRECT_CODE })).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: EmailVerificationMessageCode.USER_NOT_FOUND,
      });
    });

    it('should throw 404 userNotFound when the user is soft-deleted', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: USER_ID, email: USER_EMAIL, deletedAt: new Date() });

      await expect(verifyEmailCode(prisma, { userId: USER_ID, code: CORRECT_CODE })).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: EmailVerificationMessageCode.USER_NOT_FOUND,
      });
    });

    it('should coerce a numeric code to string before comparing', async () => {
      prisma.emailVerificationToken.findFirst.mockResolvedValue(makeToken({ tokenHash: sha256('123456') }));

      await expect(verifyEmailCode(prisma, { userId: USER_ID, code: 123456 })).resolves.toMatchObject({
        verified: true,
      });
    });
  });

  describe('resendVerificationCode', () => {
    it('should send a fresh code when no previous token exists', async () => {
      prisma.emailVerificationToken.findFirst.mockResolvedValue(null);

      const result = await resendVerificationCode(prisma, { userId: USER_ID }, { emailSender });

      expect(result).toEqual({ sent: true });
      expect(emailSender.sendEmailVerificationEmail).toHaveBeenCalledWith({
        to: USER_EMAIL,
        code: expect.stringMatching(/^\d{6}$/),
      });
    });

    it('should send when the cooldown has elapsed', async () => {
      prisma.emailVerificationToken.findFirst.mockResolvedValue({
        createdAt: new Date(NOW.getTime() - EMAIL_VERIFICATION_RESEND_COOLDOWN_MS),
      });

      await expect(resendVerificationCode(prisma, { userId: USER_ID }, { emailSender })).resolves.toEqual({
        sent: true,
      });
    });

    it('should throw 429 with retryAfterSeconds while within the 60s cooldown', async () => {
      prisma.emailVerificationToken.findFirst.mockResolvedValue({
        createdAt: new Date(NOW.getTime() - 20 * 1000),
      });

      await expect(resendVerificationCode(prisma, { userId: USER_ID }, { emailSender })).rejects.toMatchObject({
        httpStatus: 429,
        error: EmailVerificationErrorCode.RESEND_COOLDOWN,
        messageCode: EmailVerificationMessageCode.RESEND_COOLDOWN,
        details: { retryAfterSeconds: 40 },
      });
      expect(emailSender.sendEmailVerificationEmail).not.toHaveBeenCalled();
      expect(prisma.emailVerificationToken.create).not.toHaveBeenCalled();
    });

    it('should throw 409 alreadyVerified when the email is already verified', async () => {
      prisma.account.findFirst.mockResolvedValue({ id: 'acc-1' });

      await expect(resendVerificationCode(prisma, { userId: USER_ID }, { emailSender })).rejects.toMatchObject({
        httpStatus: 409,
        messageCode: EmailVerificationMessageCode.ALREADY_VERIFIED,
      });
    });

    it('should throw 404 userNotFound for a deleted user', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: USER_ID, email: USER_EMAIL, deletedAt: new Date() });

      await expect(resendVerificationCode(prisma, { userId: USER_ID }, { emailSender })).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: EmailVerificationMessageCode.USER_NOT_FOUND,
      });
    });

    it.each([
      ['a thrown error', (fn) => fn.mockRejectedValue(new Error('resend down'))],
      ['a returned Resend error', (fn) => fn.mockResolvedValue({ data: null, error: { message: 'rejected' } })],
    ])('should throw 502 emailVerification.sendFailed on %s', async (_label, arrange) => {
      prisma.emailVerificationToken.findFirst.mockResolvedValue(null);
      arrange(emailSender.sendEmailVerificationEmail);

      await expect(resendVerificationCode(prisma, { userId: USER_ID }, { emailSender })).rejects.toMatchObject({
        httpStatus: 502,
        error: EmailVerificationErrorCode.SEND_FAILED,
        messageCode: EmailVerificationMessageCode.SEND_FAILED,
      });
      expect(console.error).toHaveBeenCalled();
    });

    it.each([
      ['a thrown error', (fn) => fn.mockRejectedValue(new Error('resend down'))],
      ['a returned Resend error', (fn) => fn.mockResolvedValue({ data: null, error: { message: 'rejected' } })],
    ])('should mark the issued code row as undelivered on %s', async (_label, arrange) => {
      prisma.emailVerificationToken.findFirst.mockResolvedValue(null);
      arrange(emailSender.sendEmailVerificationEmail);

      await expect(resendVerificationCode(prisma, { userId: USER_ID }, { emailSender })).rejects.toBeDefined();

      expect(prisma.emailVerificationToken.updateMany).toHaveBeenLastCalledWith({
        where: { id: NEW_TOKEN_ID },
        data: { used: true, sendFailedAt: NOW },
      });
    });

    it('should not close the previous code when the resend email fails', async () => {
      prisma.emailVerificationToken.findFirst.mockResolvedValue(null);
      emailSender.sendEmailVerificationEmail.mockRejectedValue(new Error('resend down'));

      await expect(resendVerificationCode(prisma, { userId: USER_ID }, { emailSender })).rejects.toBeDefined();

      expect(prisma.emailVerificationToken.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ createdAt: expect.anything() }) }),
      );
    });

    it('should close only older codes once the resend email is delivered', async () => {
      prisma.emailVerificationToken.findFirst.mockResolvedValue(null);

      await resendVerificationCode(prisma, { userId: USER_ID }, { emailSender });

      expect(prisma.emailVerificationToken.updateMany).toHaveBeenCalledWith({
        where: {
          userId: USER_ID,
          used: false,
          sendFailedAt: null,
          id: { not: NEW_TOKEN_ID },
          createdAt: { lt: NOW },
        },
        data: { used: true },
      });
    });

    it('should not mark the code row as undelivered when delivery succeeds', async () => {
      prisma.emailVerificationToken.findFirst.mockResolvedValue(null);

      await resendVerificationCode(prisma, { userId: USER_ID }, { emailSender });

      expect(prisma.emailVerificationToken.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ sendFailedAt: expect.anything() }) }),
      );
    });

    it('should still throw 502 when marking the row undelivered fails', async () => {
      prisma.emailVerificationToken.findFirst.mockResolvedValue(null);
      emailSender.sendEmailVerificationEmail.mockRejectedValue(new Error('resend down'));
      prisma.emailVerificationToken.updateMany.mockRejectedValueOnce(new Error('db down'));

      await expect(resendVerificationCode(prisma, { userId: USER_ID }, { emailSender })).rejects.toMatchObject({
        httpStatus: 502,
        messageCode: EmailVerificationMessageCode.SEND_FAILED,
      });
    });

    it('should ignore undelivered rows when checking the resend cooldown', async () => {
      prisma.emailVerificationToken.findFirst.mockResolvedValue(null);

      await resendVerificationCode(prisma, { userId: USER_ID }, { emailSender });

      expect(prisma.emailVerificationToken.findFirst).toHaveBeenCalledWith({
        where: { userId: USER_ID, sendFailedAt: null },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
    });

    describe('daily code cap', () => {
      const tokensCreatedAt = (offsetsMs) => offsetsMs.map((offset) => ({ createdAt: new Date(NOW.getTime() - offset) }));

      beforeEach(() => {
        prisma.emailVerificationToken.findFirst.mockResolvedValue(null);
      });

      it('should query the newest codes of the user inside the rolling window, limited to the cap', async () => {
        await resendVerificationCode(prisma, { userId: USER_ID }, { emailSender });

        expect(prisma.emailVerificationToken.findMany).toHaveBeenCalledWith({
          where: {
            userId: USER_ID,
            sendFailedAt: null,
            createdAt: { gte: new Date(NOW.getTime() - EMAIL_VERIFICATION_DAILY_WINDOW_MS) },
          },
          orderBy: { createdAt: 'desc' },
          take: EMAIL_VERIFICATION_DAILY_MAX_CODES,
          select: { createdAt: true },
        });
      });

      it('should allow the resend when one below the cap', async () => {
        prisma.emailVerificationToken.findMany.mockResolvedValue(
          tokensCreatedAt(Array.from({ length: EMAIL_VERIFICATION_DAILY_MAX_CODES - 1 }, (_, i) => (i + 1) * 3600_000)),
        );

        await expect(resendVerificationCode(prisma, { userId: USER_ID }, { emailSender })).resolves.toEqual({ sent: true });
      });

      it('should throw 429 emailVerification.dailyLimit with retryAfterSeconds until the cap-th newest code leaves the window', async () => {
        const hoursAgo = [1, 2, 3, 4, 5].map((h) => h * 3600_000);
        prisma.emailVerificationToken.findMany.mockResolvedValue(tokensCreatedAt(hoursAgo));

        await expect(resendVerificationCode(prisma, { userId: USER_ID }, { emailSender })).rejects.toMatchObject({
          httpStatus: 429,
          error: EmailVerificationErrorCode.DAILY_LIMIT,
          messageCode: EmailVerificationMessageCode.DAILY_LIMIT,
          details: { retryAfterSeconds: (EMAIL_VERIFICATION_DAILY_WINDOW_MS - 5 * 3600_000) / 1000 },
        });
        expect(prisma.emailVerificationToken.create).not.toHaveBeenCalled();
        expect(emailSender.sendEmailVerificationEmail).not.toHaveBeenCalled();
      });

      it('should report at least 1 second when the oldest counted code is about to leave the window', async () => {
        prisma.emailVerificationToken.findMany.mockResolvedValue(
          tokensCreatedAt([100, 200, 300, 400, EMAIL_VERIFICATION_DAILY_WINDOW_MS - 1]),
        );

        await expect(resendVerificationCode(prisma, { userId: USER_ID }, { emailSender })).rejects.toMatchObject({
          details: { retryAfterSeconds: 1 },
        });
      });

      it('should check the cooldown before the daily cap', async () => {
        prisma.emailVerificationToken.findFirst.mockResolvedValue({ createdAt: new Date(NOW.getTime() - 1000) });
        prisma.emailVerificationToken.findMany.mockResolvedValue(tokensCreatedAt([1000, 2000, 3000, 4000, 5000]));

        await expect(resendVerificationCode(prisma, { userId: USER_ID }, { emailSender })).rejects.toMatchObject({
          messageCode: EmailVerificationMessageCode.RESEND_COOLDOWN,
        });
      });
    });
  });
});
