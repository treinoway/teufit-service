import crypto from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/config/email-handler.js', () => ({
  default: { sendEmailVerificationEmail: vi.fn(), sendExistingAccountSignupEmail: vi.fn() },
}));
vi.mock('../../src/services/student-invite-service.js', () => ({
  acceptPendingInvitesForUser: vi.fn(),
}));

import { acceptPendingInvitesForUser } from '../../src/services/student-invite-service.js';
import {
  EmailVerificationErrorCode,
  EmailVerificationMessageCode,
  EMAIL_PROVIDER,
  EMAIL_VERIFICATION_TTL_MS,
  EMAIL_VERIFICATION_MAX_ATTEMPTS,
  EMAIL_VERIFICATION_RESEND_COOLDOWN_MS,
  EMAIL_VERIFICATION_DAILY_MAX_CODES,
  EMAIL_VERIFICATION_DAILY_WINDOW_MS,
} from '../../src/constants/email-verification.js';
import { PENDING_SIGNUP_STALE_MS, EXISTING_ACCOUNT_NOTICE_THROTTLE_MS } from '../../src/constants/signup-verification.js';
import { verifyPassword } from '../../src/helpers/password.js';
import {
  processSignupRequest,
  processSignupResendRequest,
  verifySignupCode,
  purgeStalePendingSignups,
} from '../../src/services/signup-verification-service.js';

const NOW = new Date('2026-10-02T12:00:00.000Z');
const EMAIL = 'new.student@example.com';
const MIXED_CASE_EMAIL = '  New.Student@Example.COM ';
const PENDING_ID = 'pending-1';
const CODE_ID = 'code-1';
const NEW_CODE_ID = 'code-new';
const USER_ID = 'user-1';
const CORRECT_CODE = '123456';
const WRONG_CODE = '654321';
const PASSWORD = 'correct horse battery';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const uniqueViolation = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });

function makeCode(overrides = {}) {
  return {
    id: CODE_ID,
    pendingSignupId: PENDING_ID,
    tokenHash: sha256(CORRECT_CODE),
    used: false,
    attempts: 0,
    expiresAt: new Date(NOW.getTime() + EMAIL_VERIFICATION_TTL_MS),
    createdAt: NOW,
    sendFailedAt: null,
    ...overrides,
  };
}

function makePrisma() {
  const prisma = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    user: { findUnique: vi.fn(), create: vi.fn() },
    account: { create: vi.fn() },
    pendingSignup: {
      upsert: vi.fn().mockResolvedValue({ id: PENDING_ID }),
      findUnique: vi.fn().mockResolvedValue({ id: PENDING_ID }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    pendingSignupCode: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(makeCode()),
      findUnique: vi.fn().mockResolvedValue({ used: false }),
      create: vi.fn().mockResolvedValue({ id: NEW_CODE_ID, createdAt: NOW }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    existingAccountNotice: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn().mockResolvedValue({}),
    },
  };
  prisma.$transaction = vi.fn(async (callback) => callback(prisma));
  return prisma;
}

/** Makes findUserIdByEmailCaseInsensitive find a user, and user.findUnique return it. */
function givenEmailOwner(prisma, { deletedAt = null } = {}) {
  prisma.$queryRaw.mockResolvedValue([{ id: USER_ID }]);
  prisma.user.findUnique.mockResolvedValue({ id: USER_ID, email: EMAIL, deletedAt });
}

describe('signup-verification-service', () => {
  let prisma;
  let emailSender;
  let warnSpy;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    prisma = makePrisma();
    emailSender = {
      sendEmailVerificationEmail: vi.fn().mockResolvedValue({ data: { id: 'msg' } }),
      sendExistingAccountSignupEmail: vi.fn().mockResolvedValue({ data: { id: 'msg' } }),
    };
    acceptPendingInvitesForUser.mockResolvedValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('processSignupRequest', () => {
    describe('when the email has no account', () => {
      it('should look up the owner and upsert the pending signup with the trimmed, lowercased email', async () => {
        await processSignupRequest(prisma, { email: MIXED_CASE_EMAIL }, { emailSender });

        expect(prisma.$queryRaw.mock.calls[0][1]).toBe(EMAIL);
        expect(prisma.pendingSignup.upsert).toHaveBeenCalledWith(
          expect.objectContaining({ where: { email: EMAIL }, create: { email: EMAIL } }),
        );
      });

      it('should store only the sha256 of a 6-digit code and email the plain code to the normalized address', async () => {
        await processSignupRequest(prisma, { email: MIXED_CASE_EMAIL }, { emailSender });

        const { to, code } = emailSender.sendEmailVerificationEmail.mock.calls[0][0];
        expect(to).toBe(EMAIL);
        expect(code).toMatch(/^[0-9]{6}$/);
        expect(prisma.pendingSignupCode.create).toHaveBeenCalledWith({
          data: {
            pendingSignupId: PENDING_ID,
            tokenHash: sha256(code),
            expiresAt: new Date(NOW.getTime() + EMAIL_VERIFICATION_TTL_MS),
          },
          select: { id: true, createdAt: true },
        });
      });

      it('should close strictly older codes once the new one is delivered', async () => {
        await processSignupRequest(prisma, { email: EMAIL }, { emailSender });

        expect(prisma.pendingSignupCode.updateMany).toHaveBeenCalledWith({
          where: { pendingSignupId: PENDING_ID, used: false, sendFailedAt: null, id: { not: NEW_CODE_ID }, createdAt: { lt: NOW } },
          data: { used: true },
        });
      });

      it('should not send the "existing account" email', async () => {
        await processSignupRequest(prisma, { email: EMAIL }, { emailSender });

        expect(emailSender.sendExistingAccountSignupEmail).not.toHaveBeenCalled();
      });

      it('should retry the upsert once when two concurrent signups race on the unique email', async () => {
        prisma.pendingSignup.upsert.mockRejectedValueOnce(uniqueViolation()).mockResolvedValueOnce({ id: PENDING_ID });

        await processSignupRequest(prisma, { email: EMAIL }, { emailSender });

        expect(prisma.pendingSignup.upsert).toHaveBeenCalledTimes(2);
        expect(emailSender.sendEmailVerificationEmail).toHaveBeenCalledTimes(1);
      });

      it('should rethrow a non-unique upsert failure (logged by the deferred runner)', async () => {
        prisma.pendingSignup.upsert.mockRejectedValue(new Error('db down'));

        await expect(processSignupRequest(prisma, { email: EMAIL }, { emailSender })).rejects.toThrow('db down');
      });
    });

    describe('silent limits', () => {
      it('should issue nothing while the resend cooldown is running', async () => {
        prisma.pendingSignupCode.findMany.mockResolvedValue([
          { createdAt: new Date(NOW.getTime() - EMAIL_VERIFICATION_RESEND_COOLDOWN_MS + 1000) },
        ]);

        await expect(processSignupRequest(prisma, { email: EMAIL }, { emailSender })).resolves.toBeUndefined();

        expect(prisma.pendingSignupCode.create).not.toHaveBeenCalled();
        expect(emailSender.sendEmailVerificationEmail).not.toHaveBeenCalled();
      });

      it('should issue a new code once the cooldown has elapsed', async () => {
        prisma.pendingSignupCode.findMany.mockResolvedValue([
          { createdAt: new Date(NOW.getTime() - EMAIL_VERIFICATION_RESEND_COOLDOWN_MS - 1) },
        ]);

        await processSignupRequest(prisma, { email: EMAIL }, { emailSender });

        expect(prisma.pendingSignupCode.create).toHaveBeenCalledTimes(1);
      });

      it('should issue nothing when the daily cap of delivered codes is reached', async () => {
        const hourAgo = new Date(NOW.getTime() - 60 * 60 * 1000);
        prisma.pendingSignupCode.findMany.mockResolvedValue(
          Array.from({ length: EMAIL_VERIFICATION_DAILY_MAX_CODES }, () => ({ createdAt: hourAgo })),
        );

        await expect(processSignupRequest(prisma, { email: EMAIL }, { emailSender })).resolves.toBeUndefined();

        expect(prisma.pendingSignupCode.create).not.toHaveBeenCalled();
      });

      it('should count only delivered codes inside the daily window', async () => {
        await processSignupRequest(prisma, { email: EMAIL }, { emailSender });

        expect(prisma.pendingSignupCode.findMany).toHaveBeenCalledWith({
          where: {
            pendingSignupId: PENDING_ID,
            sendFailedAt: null,
            createdAt: { gte: new Date(NOW.getTime() - EMAIL_VERIFICATION_DAILY_WINDOW_MS) },
          },
          orderBy: { createdAt: 'desc' },
          take: EMAIL_VERIFICATION_DAILY_MAX_CODES,
          select: { createdAt: true },
        });
      });
    });

    describe('delivery failures', () => {
      it.each([
        ['the provider returns { error }', (sender) => sender.sendEmailVerificationEmail.mockResolvedValue({ error: { name: 'rejected' } })],
        ['the provider throws', (sender) => sender.sendEmailVerificationEmail.mockRejectedValue(new Error('resend down'))],
      ])('should close the code as undelivered and resolve when %s', async (_label, arrange) => {
        arrange(emailSender);

        await expect(processSignupRequest(prisma, { email: EMAIL }, { emailSender })).resolves.toBeUndefined();

        expect(prisma.pendingSignupCode.updateMany).toHaveBeenCalledTimes(1);
        expect(prisma.pendingSignupCode.updateMany).toHaveBeenCalledWith({
          where: { id: NEW_CODE_ID },
          data: { used: true, sendFailedAt: NOW },
        });
      });
    });

    describe('when the email already has an active account', () => {
      beforeEach(() => givenEmailOwner(prisma));

      it('should issue a decoy code on the pending signup without emailing it (no verify oracle)', async () => {
        await processSignupRequest(prisma, { email: MIXED_CASE_EMAIL }, { emailSender });

        expect(prisma.pendingSignup.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { email: EMAIL } }));
        expect(prisma.pendingSignupCode.create).toHaveBeenCalledWith({
          data: {
            pendingSignupId: PENDING_ID,
            tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
            expiresAt: new Date(NOW.getTime() + EMAIL_VERIFICATION_TTL_MS),
          },
          select: { id: true, createdAt: true },
        });
        expect(emailSender.sendEmailVerificationEmail).not.toHaveBeenCalled();
        expect(prisma.pendingSignup.deleteMany).not.toHaveBeenCalled();
      });

      it('should close older codes like a delivered code, never mark the decoy as undelivered', async () => {
        await processSignupRequest(prisma, { email: EMAIL }, { emailSender });

        expect(prisma.pendingSignupCode.updateMany).toHaveBeenCalledWith({
          where: { pendingSignupId: PENDING_ID, used: false, sendFailedAt: null, id: { not: NEW_CODE_ID }, createdAt: { lt: NOW } },
          data: { used: true },
        });
        expect(prisma.pendingSignupCode.updateMany).not.toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ sendFailedAt: expect.any(Date) }) }),
        );
      });

      it('should apply the same silent cooldown to the decoy code', async () => {
        prisma.pendingSignupCode.findMany.mockResolvedValue([{ createdAt: NOW }]);

        await processSignupRequest(prisma, { email: EMAIL }, { emailSender });

        expect(prisma.pendingSignupCode.create).not.toHaveBeenCalled();
      });

      it('should never write to the user or its accounts', async () => {
        await processSignupRequest(prisma, { email: EMAIL }, { emailSender });

        expect(prisma.user.create).not.toHaveBeenCalled();
        expect(prisma.account.create).not.toHaveBeenCalled();
      });

      it('should send the "existing account" email to the stored address on the first notice', async () => {
        await processSignupRequest(prisma, { email: EMAIL }, { emailSender });

        expect(prisma.existingAccountNotice.create).toHaveBeenCalledWith({ data: { email: EMAIL, lastSentAt: NOW } });
        expect(emailSender.sendExistingAccountSignupEmail).toHaveBeenCalledWith({ to: EMAIL });
      });

      it('should claim the slot only when the previous notice is older than the throttle window', async () => {
        prisma.existingAccountNotice.updateMany.mockResolvedValue({ count: 1 });

        await processSignupRequest(prisma, { email: EMAIL }, { emailSender });

        expect(prisma.existingAccountNotice.updateMany).toHaveBeenCalledWith({
          where: { email: EMAIL, lastSentAt: { lt: new Date(NOW.getTime() - EXISTING_ACCOUNT_NOTICE_THROTTLE_MS) } },
          data: { lastSentAt: NOW },
        });
        expect(prisma.existingAccountNotice.create).not.toHaveBeenCalled();
        expect(emailSender.sendExistingAccountSignupEmail).toHaveBeenCalledTimes(1);
      });

      it('should send nothing while throttled (recent notice row exists)', async () => {
        prisma.existingAccountNotice.create.mockRejectedValue(uniqueViolation());

        await processSignupRequest(prisma, { email: EMAIL }, { emailSender });

        expect(emailSender.sendExistingAccountSignupEmail).not.toHaveBeenCalled();
      });

      it('should swallow a notice delivery failure', async () => {
        emailSender.sendExistingAccountSignupEmail.mockRejectedValue(new Error('resend down'));

        await expect(processSignupRequest(prisma, { email: EMAIL }, { emailSender })).resolves.toBeUndefined();
      });
    });

    describe('when the email belongs to a deleted account', () => {
      it('should send no email at all, only issue a decoy code', async () => {
        givenEmailOwner(prisma, { deletedAt: new Date('2026-01-01T00:00:00.000Z') });

        await processSignupRequest(prisma, { email: EMAIL }, { emailSender });

        expect(emailSender.sendEmailVerificationEmail).not.toHaveBeenCalled();
        expect(emailSender.sendExistingAccountSignupEmail).not.toHaveBeenCalled();
        expect(prisma.existingAccountNotice.updateMany).not.toHaveBeenCalled();
        expect(prisma.pendingSignupCode.create).toHaveBeenCalledTimes(1);
      });
    });

    it('should do nothing for a blank email', async () => {
      await processSignupRequest(prisma, { email: '   ' }, { emailSender });

      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(prisma.pendingSignup.upsert).not.toHaveBeenCalled();
    });

    it('should never log the email or the code', async () => {
      emailSender.sendEmailVerificationEmail.mockResolvedValue({ error: { name: 'rejected' } });

      await processSignupRequest(prisma, { email: EMAIL }, { emailSender });

      const { code } = emailSender.sendEmailVerificationEmail.mock.calls[0][0];
      const logged = JSON.stringify(warnSpy.mock.calls);
      expect(warnSpy).toHaveBeenCalled();
      expect(logged).not.toContain(EMAIL);
      expect(logged).not.toContain(code);
    });
  });

  describe('processSignupResendRequest', () => {
    it('should do nothing when there is no pending signup and no account', async () => {
      prisma.pendingSignup.updateMany.mockResolvedValue({ count: 0 });

      await processSignupResendRequest(prisma, { email: EMAIL }, { emailSender });

      expect(prisma.pendingSignup.upsert).not.toHaveBeenCalled();
      expect(prisma.pendingSignupCode.create).not.toHaveBeenCalled();
      expect(emailSender.sendEmailVerificationEmail).not.toHaveBeenCalled();
      expect(emailSender.sendExistingAccountSignupEmail).not.toHaveBeenCalled();
    });

    it('should refresh the pending signup and email a new code when one exists', async () => {
      await processSignupResendRequest(prisma, { email: MIXED_CASE_EMAIL }, { emailSender });

      expect(prisma.pendingSignup.updateMany).toHaveBeenCalledWith({ where: { email: EMAIL }, data: { updatedAt: NOW } });
      expect(emailSender.sendEmailVerificationEmail).toHaveBeenCalledWith(expect.objectContaining({ to: EMAIL }));
    });

    it('should apply the cooldown silently', async () => {
      prisma.pendingSignupCode.findMany.mockResolvedValue([{ createdAt: NOW }]);

      await expect(processSignupResendRequest(prisma, { email: EMAIL }, { emailSender })).resolves.toBeUndefined();

      expect(prisma.pendingSignupCode.create).not.toHaveBeenCalled();
    });

    it('should send the "existing account" email instead of a code when the email has an account', async () => {
      givenEmailOwner(prisma);

      await processSignupResendRequest(prisma, { email: EMAIL }, { emailSender });

      expect(emailSender.sendExistingAccountSignupEmail).toHaveBeenCalledWith({ to: EMAIL });
      expect(emailSender.sendEmailVerificationEmail).not.toHaveBeenCalled();
    });

    it('should rotate the decoy code (unsent) when an owned email has a pending signup', async () => {
      givenEmailOwner(prisma);

      await processSignupResendRequest(prisma, { email: EMAIL }, { emailSender });

      expect(prisma.pendingSignupCode.create).toHaveBeenCalledTimes(1);
      expect(emailSender.sendEmailVerificationEmail).not.toHaveBeenCalled();
    });

    it('should not create a pending signup for an owned email without one', async () => {
      givenEmailOwner(prisma);
      prisma.pendingSignup.updateMany.mockResolvedValue({ count: 0 });

      await processSignupResendRequest(prisma, { email: EMAIL }, { emailSender });

      expect(prisma.pendingSignup.upsert).not.toHaveBeenCalled();
      expect(prisma.pendingSignupCode.create).not.toHaveBeenCalled();
    });
  });

  describe('verifySignupCode', () => {
    const verify = (overrides = {}) =>
      verifySignupCode(prisma, { email: EMAIL, code: CORRECT_CODE, password: PASSWORD, ...overrides });

    beforeEach(() => {
      prisma.user.create.mockImplementation(async ({ data }) => ({ id: USER_ID, ...data }));
      prisma.account.create.mockResolvedValue({ id: 'acc-1' });
      prisma.pendingSignup.deleteMany.mockResolvedValue({ count: 1 });
    });

    function expectInvalidCode(promise) {
      return expect(promise).rejects.toMatchObject({
        httpStatus: 400,
        error: EmailVerificationErrorCode.INVALID_CODE,
        messageCode: EmailVerificationMessageCode.INVALID_CODE,
      });
    }

    describe('happy path', () => {
      it('should create the user with a scrypt hash of the password sent with the code', async () => {
        await verify();

        const { data } = prisma.user.create.mock.calls[0][0];
        expect(data).toMatchObject({ email: EMAIL, roles: [], status: 'pending' });
        expect(verifyPassword(PASSWORD, data.passwordHash)).toBe(true);
      });

      it('should create the email account already verified', async () => {
        await verify();

        expect(prisma.account.create).toHaveBeenCalledWith({
          data: { userId: USER_ID, provider: EMAIL_PROVIDER, providerId: EMAIL, verifiedAt: NOW },
        });
      });

      it('should consume the code with a conditional update and delete the pending signup inside the transaction', async () => {
        await verify();

        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(prisma.pendingSignupCode.updateMany).toHaveBeenCalledWith({
          where: { id: CODE_ID, used: false },
          data: { used: true },
        });
        expect(prisma.pendingSignup.deleteMany).toHaveBeenCalledWith({ where: { id: PENDING_ID } });
      });

      it('should accept pending trainer invites and return the linked count with the user', async () => {
        acceptPendingInvitesForUser.mockResolvedValue(2);

        const result = await verify();

        expect(acceptPendingInvitesForUser).toHaveBeenCalledWith(prisma, expect.objectContaining({ id: USER_ID, email: EMAIL }));
        expect(result.linkedTrainers).toBe(2);
        expect(result.user.id).toBe(USER_ID);
      });

      it('should match the pending signup case-insensitively and accept a code with surrounding spaces', async () => {
        await verify({ email: MIXED_CASE_EMAIL, code: ` ${CORRECT_CODE} ` });

        expect(prisma.pendingSignup.findUnique).toHaveBeenCalledWith({ where: { email: EMAIL }, select: { id: true } });
        expect(prisma.user.create).toHaveBeenCalledTimes(1);
      });

      it('should consume one attempt before comparing the code', async () => {
        await verify();

        expect(prisma.pendingSignupCode.updateMany).toHaveBeenCalledWith({
          where: { id: CODE_ID, used: false, attempts: { lt: EMAIL_VERIFICATION_MAX_ATTEMPTS } },
          data: { attempts: { increment: 1 } },
        });
      });
    });

    describe('indistinguishable invalidCode outcomes', () => {
      it('should reject when there is no pending signup for the email', async () => {
        prisma.pendingSignup.findUnique.mockResolvedValue(null);

        await expectInvalidCode(verify());
        expect(prisma.pendingSignupCode.findFirst).not.toHaveBeenCalled();
      });

      it('should reject when the pending signup has no active code', async () => {
        prisma.pendingSignupCode.findFirst.mockResolvedValue(null);

        await expectInvalidCode(verify());
      });

      it('should reject a wrong code without creating anything', async () => {
        await expectInvalidCode(verify({ code: WRONG_CODE }));

        expect(prisma.user.create).not.toHaveBeenCalled();
        expect(prisma.pendingSignup.deleteMany).not.toHaveBeenCalled();
      });

      it('should reject and discard the pending signup when the email got an account meanwhile (e.g. Google sign-in)', async () => {
        prisma.$queryRaw.mockResolvedValue([{ id: 'oauth-user' }]);

        await expectInvalidCode(verify());

        expect(prisma.pendingSignup.deleteMany).toHaveBeenCalledWith({ where: { email: EMAIL } });
        expect(prisma.user.create).not.toHaveBeenCalled();
      });

      it('should only check for an existing account after the code matched', async () => {
        prisma.$queryRaw.mockResolvedValue([{ id: 'oauth-user' }]);

        await expectInvalidCode(verify({ code: WRONG_CODE }));

        expect(prisma.$queryRaw).not.toHaveBeenCalled();
        expect(prisma.pendingSignup.deleteMany).not.toHaveBeenCalled();
      });

      it('should reject the loser of two concurrent verifications of the same code', async () => {
        prisma.pendingSignupCode.updateMany.mockImplementation(async ({ where }) => ({
          count: where.attempts ? 1 : 0,
        }));

        await expectInvalidCode(verify());
        expect(prisma.user.create).not.toHaveBeenCalled();
      });

      it('should reject and discard the pending signup when the user insert hits the unique email (OAuth race)', async () => {
        prisma.$transaction.mockRejectedValue(uniqueViolation());

        await expectInvalidCode(verify());

        expect(prisma.pendingSignup.deleteMany).toHaveBeenCalledWith({ where: { email: EMAIL } });
        expect(acceptPendingInvitesForUser).not.toHaveBeenCalled();
      });
    });

    it.each([
      ['consumed by a concurrent verification', { used: true }],
      ['deleted with its pending signup', null],
    ])('should answer invalidCode (not tooManyAttempts) when the code was %s', async (_label, current) => {
      prisma.pendingSignupCode.updateMany.mockResolvedValue({ count: 0 });
      prisma.pendingSignupCode.findUnique.mockResolvedValue(current);

      await expectInvalidCode(verify());
    });

    it('should rethrow unexpected transaction failures', async () => {
      prisma.$transaction.mockRejectedValue(new Error('db down'));

      await expect(verify()).rejects.toThrow('db down');
    });

    it('should reject an expired code with codeExpired', async () => {
      prisma.pendingSignupCode.findFirst.mockResolvedValue(makeCode({ expiresAt: new Date(NOW.getTime() - 1) }));

      await expect(verify()).rejects.toMatchObject({
        httpStatus: 400,
        error: EmailVerificationErrorCode.CODE_EXPIRED,
        messageCode: EmailVerificationMessageCode.CODE_EXPIRED,
      });
    });

    it('should reject with tooManyAttempts once the attempts cap is reached, even with the right code', async () => {
      prisma.pendingSignupCode.updateMany.mockResolvedValue({ count: 0 });

      await expect(verify()).rejects.toMatchObject({
        httpStatus: 429,
        error: EmailVerificationErrorCode.TOO_MANY_ATTEMPTS,
        messageCode: EmailVerificationMessageCode.TOO_MANY_ATTEMPTS,
      });
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('should only consider the newest unused, delivered code', async () => {
      await verify();

      expect(prisma.pendingSignupCode.findFirst).toHaveBeenCalledWith({
        where: { pendingSignupId: PENDING_ID, used: false, sendFailedAt: null },
        orderBy: { createdAt: 'desc' },
      });
    });
  });

  describe('purgeStalePendingSignups', () => {
    it('should delete pending signups idle for longer than the stale window', async () => {
      prisma.pendingSignup.deleteMany.mockResolvedValue({ count: 3 });

      await expect(purgeStalePendingSignups(prisma)).resolves.toBe(3);
      expect(prisma.pendingSignup.deleteMany).toHaveBeenCalledWith({
        where: { updatedAt: { lt: new Date(NOW.getTime() - PENDING_SIGNUP_STALE_MS) } },
      });
    });
  });
});
