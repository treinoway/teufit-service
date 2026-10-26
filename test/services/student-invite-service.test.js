import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/config/email-handler.js', () => ({
  default: { sendStudentInviteEmail: vi.fn(), sendExistingUserStudentInviteEmail: vi.fn() },
}));
vi.mock('../../src/services/email-verification-service.js', () => ({
  issueCodeRespectingLimits: vi.fn(),
  markVerificationSendFailed: vi.fn(),
  confirmVerificationCodeDelivered: vi.fn(),
  isUserEmailVerified: vi.fn(),
}));
vi.mock('../../src/helpers/email-lookup.js', () => ({
  findUserIdByEmailCaseInsensitive: vi.fn(),
}));
vi.mock('../../src/services/platform-plan-service.js', () => ({
  assertStudentCap: vi.fn(),
}));
vi.mock('../../src/services/trainer-service.js', () => ({
  linkStudentByEmail: vi.fn(),
}));
vi.mock('../../src/services/trainer-onboarding-service.js', () => ({
  maybeMarkFirstStudentLinked: vi.fn(),
}));
vi.mock('../../src/services/briefing-service.js', () => ({
  markBriefingDirty: vi.fn(),
}));

import emailHandler from '../../src/config/email-handler.js';
import {
  issueCodeRespectingLimits,
  markVerificationSendFailed,
  confirmVerificationCodeDelivered,
  isUserEmailVerified,
} from '../../src/services/email-verification-service.js';
import { findUserIdByEmailCaseInsensitive } from '../../src/helpers/email-lookup.js';
import { assertStudentCap } from '../../src/services/platform-plan-service.js';
import { linkStudentByEmail } from '../../src/services/trainer-service.js';
import { maybeMarkFirstStudentLinked } from '../../src/services/trainer-onboarding-service.js';
import { markBriefingDirty } from '../../src/services/briefing-service.js';
import { AppError } from '../../src/errors/app-error.js';
import { PLATFORM_PLAN_ERRORS } from '../../src/constants/platform-plan.js';
import {
  StudentInviteStatus,
  StudentInviteOutcome,
  StudentInviteErrorCode,
  StudentInviteMessageCode,
  STUDENT_INVITE_TTL_MS,
  STUDENT_INVITE_RESEND_COOLDOWN_MS,
  STUDENT_INVITE_MAX_SENDS,
  STUDENT_INVITE_DAILY_MAX,
  STUDENT_INVITE_DAILY_WINDOW_MS,
  STUDENT_INVITE_LIST_PAGE_SIZE_DEFAULT,
  STUDENT_INVITE_LIST_PAGE_SIZE_MAX,
} from '../../src/constants/student-invite.js';
import {
  inviteStudent,
  listStudentInvites,
  resendStudentInvite,
  revokeStudentInvite,
  acceptPendingInvitesForUser,
  computeResendAvailability,
} from '../../src/services/student-invite-service.js';

const TRAINER_ID = 'trainer-1';
const TRAINER_USER_ID = 'trainer-user-1';
const INVITE_ID = 'invite-1';
const STUDENT_EMAIL = 'student@example.com';
const NOW = new Date('2026-09-29T12:00:00.000Z');
const MS_PER_MINUTE = 60 * 1000;
const ISSUED_CODE = '482913';
const ISSUED_TOKEN_ID = 'token-issued';
const ISSUED_CREATED_AT = new Date('2026-09-29T11:59:59.000Z');

const ISSUED = {
  code: ISSUED_CODE,
  tokenId: ISSUED_TOKEN_ID,
  userId: 'user-9',
  createdAt: ISSUED_CREATED_AT,
};

function makePrisma() {
  const prisma = {
    user: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    account: { findFirst: vi.fn() },
    studentInvite: {
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    trainerStudent: { createMany: vi.fn(), findUnique: vi.fn() },
  };
  prisma.$transaction = vi.fn(async (callback) => callback(prisma));
  return prisma;
}

function makeInvite(overrides = {}) {
  return {
    id: INVITE_ID,
    trainerId: TRAINER_ID,
    email: STUDENT_EMAIL,
    status: StudentInviteStatus.PENDING,
    studentId: null,
    expiresAt: new Date(NOW.getTime() + STUDENT_INVITE_TTL_MS),
    acceptedAt: null,
    revokedAt: null,
    lastSentAt: new Date(NOW.getTime() - STUDENT_INVITE_RESEND_COOLDOWN_MS - MS_PER_MINUTE),
    sendCount: 1,
    createdAt: new Date(NOW.getTime() - 2 * STUDENT_INVITE_RESEND_COOLDOWN_MS),
    ...overrides,
  };
}

function capExceededError() {
  return new AppError({
    httpStatus: PLATFORM_PLAN_ERRORS.STUDENT_CAP_EXCEEDED.status,
    error: PLATFORM_PLAN_ERRORS.STUDENT_CAP_EXCEEDED.code,
    messageCode: PLATFORM_PLAN_ERRORS.STUDENT_CAP_EXCEEDED.messageCode,
    message: 'cap',
  });
}

const ACTIVE_USER_STATUS = 'active';

// Collects the argument objects of every user update/updateMany call made on the mock.
function userStatusWrites(prisma) {
  return [...prisma.user.update.mock.calls, ...prisma.user.updateMany.mock.calls].map(([args]) => args);
}

describe('student-invite-service', () => {
  let prisma;
  let emailSender;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    prisma = makePrisma();
    emailSender = {
      sendStudentInviteEmail: vi.fn().mockResolvedValue(undefined),
      sendExistingUserStudentInviteEmail: vi.fn().mockResolvedValue(undefined),
    };
    issueCodeRespectingLimits.mockResolvedValue(ISSUED);
    markVerificationSendFailed.mockResolvedValue(undefined);
    confirmVerificationCodeDelivered.mockResolvedValue(undefined);
    // Delegate to the (mocked) prisma so tests keep driving verification via prisma.account.findFirst.
    isUserEmailVerified.mockImplementation(async (p, userId) =>
      Boolean(await p.account.findFirst({ where: { userId, verifiedAt: { not: null } }, select: { id: true } })),
    );
    prisma.user.findUnique.mockResolvedValue({ firstName: 'Ana', lastName: 'Coach', email: STUDENT_EMAIL, deletedAt: null });
    findUserIdByEmailCaseInsensitive.mockResolvedValue(null);
    prisma.studentInvite.findMany.mockResolvedValue([]);
    prisma.studentInvite.updateMany.mockResolvedValue({ count: 0 });
    prisma.account.findFirst.mockResolvedValue({ id: 'acc-verified' });
    prisma.trainerStudent.findUnique.mockResolvedValue(null);
    assertStudentCap.mockResolvedValue(undefined);
    maybeMarkFirstStudentLinked.mockResolvedValue(undefined);
    markBriefingDirty.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('inviteStudent', () => {
    const args = () => ({ trainerId: TRAINER_ID, trainerUserId: TRAINER_USER_ID, email: '  Student@Example.COM ' });

    describe('when the email belongs to a registered user with a verified email', () => {
      const STUDENT_USER_ID = 'user-9';

      beforeEach(() => {
        findUserIdByEmailCaseInsensitive.mockResolvedValue(STUDENT_USER_ID);
        prisma.user.findUnique.mockResolvedValue({ id: STUDENT_USER_ID, email: 'Student@Example.com', deletedAt: null });
        linkStudentByEmail.mockResolvedValue({ id: STUDENT_USER_ID });
      });

      it('should link immediately with the stored email and return outcome linked', async () => {
        const result = await inviteStudent(prisma, args(), { emailSender });

        expect(findUserIdByEmailCaseInsensitive).toHaveBeenCalledWith(prisma, STUDENT_EMAIL);
        expect(prisma.account.findFirst).toHaveBeenCalledWith({
          where: { userId: STUDENT_USER_ID, verifiedAt: { not: null } },
          select: { id: true },
        });
        expect(linkStudentByEmail).toHaveBeenCalledWith({
          trainerId: TRAINER_ID,
          trainerUserId: TRAINER_USER_ID,
          email: 'Student@Example.com',
        });
        expect(result).toEqual({ outcome: StudentInviteOutcome.LINKED, student: { id: STUDENT_USER_ID } });
      });

      it('should not create an invite, send an invite email or apply caps when linking', async () => {
        await inviteStudent(prisma, args(), { emailSender });

        expect(prisma.studentInvite.create).not.toHaveBeenCalled();
        expect(emailSender.sendStudentInviteEmail).not.toHaveBeenCalled();
        expect(assertStudentCap).not.toHaveBeenCalled();
        expect(prisma.studentInvite.findMany).not.toHaveBeenCalled();
      });

      it('should mark this trainer\'s pending invite for the email accepted with the student id', async () => {
        await inviteStudent(prisma, args(), { emailSender });

        expect(prisma.studentInvite.updateMany).toHaveBeenCalledWith({
          where: { trainerId: TRAINER_ID, email: STUDENT_EMAIL, status: StudentInviteStatus.PENDING },
          data: { status: StudentInviteStatus.ACCEPTED, studentId: STUDENT_USER_ID, acceptedAt: NOW },
        });
      });

      it('should not mark any invite accepted when linking fails', async () => {
        const failure = new AppError({ httpStatus: 409, error: 'X', messageCode: 'x.y', message: 'x' });
        linkStudentByEmail.mockRejectedValue(failure);

        await expect(inviteStudent(prisma, args(), { emailSender })).rejects.toBe(failure);
        expect(prisma.studentInvite.updateMany).not.toHaveBeenCalled();
      });
    });

    describe('when the email belongs to a registered user with an unverified email', () => {
      const STUDENT_USER_ID = 'user-9';

      beforeEach(() => {
        findUserIdByEmailCaseInsensitive.mockResolvedValue(STUDENT_USER_ID);
        prisma.user.findUnique.mockImplementation(async ({ where }) =>
          where.id === STUDENT_USER_ID
            ? { id: STUDENT_USER_ID, email: STUDENT_EMAIL, deletedAt: null }
            : { firstName: 'Ana', lastName: 'Coach' },
        );
        prisma.account.findFirst.mockResolvedValue(null);
        prisma.studentInvite.create.mockImplementation(async ({ data }) => makeInvite(data));
      });

      it('should create a pending invite and return outcome invited without linking', async () => {
        const result = await inviteStudent(prisma, args(), { emailSender });

        expect(linkStudentByEmail).not.toHaveBeenCalled();
        expect(prisma.studentInvite.create).toHaveBeenCalledTimes(1);
        expect(result.outcome).toBe(StudentInviteOutcome.INVITED);
        expect(result.invite.status).toBe(StudentInviteStatus.PENDING);
      });

      it('should send the existing-user variant email carrying the issued code, and apply the daily and student caps', async () => {
        await inviteStudent(prisma, args(), { emailSender });

        expect(issueCodeRespectingLimits).toHaveBeenCalledWith(prisma, STUDENT_USER_ID);
        expect(emailSender.sendExistingUserStudentInviteEmail).toHaveBeenCalledWith({
          to: STUDENT_EMAIL,
          trainerName: 'Ana Coach',
          code: ISSUED_CODE,
        });
        expect(emailSender.sendStudentInviteEmail).not.toHaveBeenCalled();
        expect(markVerificationSendFailed).not.toHaveBeenCalled();
        expect(confirmVerificationCodeDelivered).toHaveBeenCalledWith(prisma, ISSUED);
        expect(prisma.studentInvite.findMany).toHaveBeenCalledTimes(1);
        expect(assertStudentCap).toHaveBeenCalledWith(prisma, TRAINER_ID);
      });

      it('should still invite and send the variant with code null when issuing is blocked by cooldown or cap', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        issueCodeRespectingLimits.mockRejectedValue(
          new AppError({ httpStatus: 429, error: 'X', messageCode: 'x.y', message: 'blocked' }),
        );

        const result = await inviteStudent(prisma, args(), { emailSender });

        expect(result.outcome).toBe(StudentInviteOutcome.INVITED);
        expect(emailSender.sendExistingUserStudentInviteEmail).toHaveBeenCalledWith({
          to: STUDENT_EMAIL,
          trainerName: 'Ana Coach',
          code: null,
        });
        expect(markVerificationSendFailed).not.toHaveBeenCalled();
      });

      it.each([
        ['a thrown error', (fn) => fn.mockRejectedValue(new Error('resend down'))],
        ['a returned Resend error', (fn) => fn.mockResolvedValue({ data: null, error: { message: 'rejected' } })],
      ])('should still invite and mark the issued token undelivered when the variant email fails with %s', async (_label, arrange) => {
        arrange(emailSender.sendExistingUserStudentInviteEmail);

        const result = await inviteStudent(prisma, args(), { emailSender });

        expect(result.outcome).toBe(StudentInviteOutcome.INVITED);
        expect(markVerificationSendFailed).toHaveBeenCalledWith(prisma, ISSUED_TOKEN_ID);
        expect(confirmVerificationCodeDelivered).not.toHaveBeenCalled();
      });

      it('should not mark any token when the variant email fails and no code was issued', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        issueCodeRespectingLimits.mockRejectedValue(new Error('blocked'));
        emailSender.sendExistingUserStudentInviteEmail.mockRejectedValue(new Error('resend down'));

        await expect(inviteStudent(prisma, args(), { emailSender })).resolves.toMatchObject({
          outcome: StudentInviteOutcome.INVITED,
        });
        expect(markVerificationSendFailed).not.toHaveBeenCalled();
      });

      it('should throw 422 student.cannotLinkSelf when the unverified user is the trainer', async () => {
        prisma.user.findUnique.mockResolvedValue({ id: TRAINER_USER_ID, email: STUDENT_EMAIL, deletedAt: null });
        findUserIdByEmailCaseInsensitive.mockResolvedValue(TRAINER_USER_ID);

        await expect(inviteStudent(prisma, args(), { emailSender })).rejects.toMatchObject({
          httpStatus: 422,
          error: StudentInviteErrorCode.CANNOT_LINK_SELF,
          messageCode: StudentInviteMessageCode.CANNOT_LINK_SELF,
        });
        expect(prisma.studentInvite.create).not.toHaveBeenCalled();
      });

      it('should throw 409 student.alreadyLinked when the unverified user is already linked to this trainer', async () => {
        prisma.trainerStudent.findUnique.mockResolvedValue({ trainerId: TRAINER_ID });

        await expect(inviteStudent(prisma, args(), { emailSender })).rejects.toMatchObject({
          httpStatus: 409,
          messageCode: StudentInviteMessageCode.ALREADY_LINKED,
        });
        expect(prisma.trainerStudent.findUnique).toHaveBeenCalledWith({
          where: { trainerId_studentId: { trainerId: TRAINER_ID, studentId: STUDENT_USER_ID } },
          select: { trainerId: true },
        });
        expect(prisma.studentInvite.create).not.toHaveBeenCalled();
      });

      it('should throw 409 studentInvite.alreadyPending when a pending invite already exists (P2002)', async () => {
        prisma.studentInvite.create.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));

        await expect(inviteStudent(prisma, args(), { emailSender })).rejects.toMatchObject({
          httpStatus: 409,
          messageCode: StudentInviteMessageCode.ALREADY_PENDING,
        });
      });

      it('should throw 422 student.accountDeactivated when the user is soft-deleted, even if unverified', async () => {
        prisma.user.findUnique.mockResolvedValue({ id: STUDENT_USER_ID, email: STUDENT_EMAIL, deletedAt: new Date() });

        await expect(inviteStudent(prisma, args(), { emailSender })).rejects.toMatchObject({
          httpStatus: 422,
          messageCode: StudentInviteMessageCode.STUDENT_ACCOUNT_DEACTIVATED,
        });
        expect(prisma.studentInvite.create).not.toHaveBeenCalled();
      });
    });

    describe('when the registered user cannot be linked', () => {
      beforeEach(() => {
        findUserIdByEmailCaseInsensitive.mockResolvedValue('user-9');
      });

      it('should throw 422 student.accountDeactivated when the user is soft-deleted', async () => {
        prisma.user.findUnique.mockResolvedValue({ id: 'user-9', email: STUDENT_EMAIL, deletedAt: new Date() });

        await expect(inviteStudent(prisma, args(), { emailSender })).rejects.toMatchObject({
          httpStatus: 422,
          error: StudentInviteErrorCode.STUDENT_ACCOUNT_DEACTIVATED,
          messageCode: StudentInviteMessageCode.STUDENT_ACCOUNT_DEACTIVATED,
        });
        expect(linkStudentByEmail).not.toHaveBeenCalled();
      });

      it('should throw 422 student.accountDeactivated when the user row vanished', async () => {
        prisma.user.findUnique.mockResolvedValue(null);

        await expect(inviteStudent(prisma, args(), { emailSender })).rejects.toMatchObject({
          httpStatus: 422,
          messageCode: StudentInviteMessageCode.STUDENT_ACCOUNT_DEACTIVATED,
        });
      });

      it('should throw 422 student.cannotLinkSelf for a verified trainer inviting their own email', async () => {
        prisma.user.findUnique.mockResolvedValue({ id: 'user-9', email: STUDENT_EMAIL, deletedAt: null });

        await expect(inviteStudent(prisma, { ...args(), trainerUserId: 'user-9' }, { emailSender })).rejects.toMatchObject({
          httpStatus: 422,
          error: StudentInviteErrorCode.CANNOT_LINK_SELF,
          messageCode: StudentInviteMessageCode.CANNOT_LINK_SELF,
        });
        expect(linkStudentByEmail).not.toHaveBeenCalled();
      });

      it('should propagate errors thrown by linkStudentByEmail', async () => {
        prisma.user.findUnique.mockResolvedValue({ id: 'user-9', email: STUDENT_EMAIL, deletedAt: null });
        const failure = new AppError({ httpStatus: 409, error: 'X', messageCode: 'student.alreadyLinked', message: 'x' });
        linkStudentByEmail.mockRejectedValue(failure);

        await expect(inviteStudent(prisma, args(), { emailSender })).rejects.toBe(failure);
      });
    });

    describe('when the email is not registered', () => {
      beforeEach(() => {
        prisma.studentInvite.create.mockImplementation(async ({ data }) => makeInvite(data));
      });

      it('should create a pending invite with normalized email and 30 day expiry, outcome invited', async () => {
        const result = await inviteStudent(prisma, args(), { emailSender });

        expect(prisma.studentInvite.create).toHaveBeenCalledWith({
          data: {
            trainerId: TRAINER_ID,
            email: STUDENT_EMAIL,
            expiresAt: new Date(NOW.getTime() + STUDENT_INVITE_TTL_MS),
          },
        });
        expect(result.outcome).toBe(StudentInviteOutcome.INVITED);
        expect(result.invite.email).toBe(STUDENT_EMAIL);
      });

      it('should expire this trainer\'s time-expired pending invite for the email before creating a new one', async () => {
        await inviteStudent(prisma, args(), { emailSender });

        expect(prisma.studentInvite.updateMany).toHaveBeenCalledWith({
          where: {
            trainerId: TRAINER_ID,
            email: STUDENT_EMAIL,
            status: StudentInviteStatus.PENDING,
            expiresAt: { lt: NOW },
          },
          data: { status: StudentInviteStatus.EXPIRED },
        });
        expect(prisma.studentInvite.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
          prisma.studentInvite.create.mock.invocationCallOrder[0],
        );
      });

      it('should check the student cap before creating the invite', async () => {
        await inviteStudent(prisma, args(), { emailSender });

        expect(assertStudentCap).toHaveBeenCalledWith(prisma, TRAINER_ID);
        expect(assertStudentCap.mock.invocationCallOrder[0]).toBeLessThan(
          prisma.studentInvite.create.mock.invocationCallOrder[0],
        );
      });

      it('should propagate the cap error and create nothing when over the cap', async () => {
        assertStudentCap.mockRejectedValue(capExceededError());

        await expect(inviteStudent(prisma, args(), { emailSender })).rejects.toMatchObject({
          error: PLATFORM_PLAN_ERRORS.STUDENT_CAP_EXCEEDED.code,
        });
        expect(prisma.studentInvite.create).not.toHaveBeenCalled();
        expect(emailSender.sendStudentInviteEmail).not.toHaveBeenCalled();
      });

      it('should email the prospective student with the trainer full name', async () => {
        await inviteStudent(prisma, args(), { emailSender });

        expect(prisma.user.findUnique).toHaveBeenCalledWith({
          where: { id: TRAINER_USER_ID },
          select: { firstName: true, lastName: true },
        });
        expect(emailSender.sendStudentInviteEmail).toHaveBeenCalledWith({
          to: STUDENT_EMAIL,
          trainerName: 'Ana Coach',
        });
      });

      it('should default to the shared emailHandler when no emailSender is injected', async () => {
        await inviteStudent(prisma, args());

        expect(emailHandler.sendStudentInviteEmail).toHaveBeenCalledTimes(1);
      });

      it('should still return the invite when the email send throws', async () => {
        emailSender.sendStudentInviteEmail.mockRejectedValue(new Error('resend down'));

        const result = await inviteStudent(prisma, args(), { emailSender });

        expect(result.outcome).toBe(StudentInviteOutcome.INVITED);
        expect(console.error).toHaveBeenCalled();
      });

      it('should still return the invite and log when Resend returns an error', async () => {
        const resendError = { message: 'invalid recipient' };
        emailSender.sendStudentInviteEmail.mockResolvedValue({ data: null, error: resendError });

        const result = await inviteStudent(prisma, args(), { emailSender });

        expect(result.outcome).toBe(StudentInviteOutcome.INVITED);
        expect(console.error).toHaveBeenCalledWith('Failed to send student invite email', resendError);
      });

      describe('daily invite cap', () => {
        const createdAtList = (count, offsetMs) =>
          Array.from({ length: count }, (_, i) => ({ createdAt: new Date(NOW.getTime() - offsetMs(i)) }));

        it('should query the trainer\'s newest invites inside the rolling window, limited to the cap', async () => {
          await inviteStudent(prisma, args(), { emailSender });

          expect(prisma.studentInvite.findMany).toHaveBeenCalledWith({
            where: { trainerId: TRAINER_ID, createdAt: { gte: new Date(NOW.getTime() - STUDENT_INVITE_DAILY_WINDOW_MS) } },
            orderBy: { createdAt: 'desc' },
            take: STUDENT_INVITE_DAILY_MAX,
            select: { createdAt: true },
          });
        });

        it('should allow the invite when one below the cap', async () => {
          prisma.studentInvite.findMany.mockResolvedValue(
            createdAtList(STUDENT_INVITE_DAILY_MAX - 1, (i) => (i + 1) * 1000),
          );

          const result = await inviteStudent(prisma, args(), { emailSender });

          expect(result.outcome).toBe(StudentInviteOutcome.INVITED);
        });

        it('should throw 429 studentInvite.dailyLimit with retryAfterSeconds until the cap-th newest invite leaves the window', async () => {
          const tenHoursMs = 10 * 60 * MS_PER_MINUTE;
          prisma.studentInvite.findMany.mockResolvedValue(
            createdAtList(STUDENT_INVITE_DAILY_MAX, (i) => (i === STUDENT_INVITE_DAILY_MAX - 1 ? tenHoursMs : i * 1000)),
          );

          await expect(inviteStudent(prisma, args(), { emailSender })).rejects.toMatchObject({
            httpStatus: 429,
            error: StudentInviteErrorCode.DAILY_LIMIT,
            messageCode: StudentInviteMessageCode.DAILY_LIMIT,
            details: { retryAfterSeconds: (STUDENT_INVITE_DAILY_WINDOW_MS - tenHoursMs) / 1000 },
          });
        });

        it('should create nothing and send no email when over the cap', async () => {
          prisma.studentInvite.findMany.mockResolvedValue(createdAtList(STUDENT_INVITE_DAILY_MAX, (i) => (i + 1) * 1000));

          await expect(inviteStudent(prisma, args(), { emailSender })).rejects.toBeInstanceOf(AppError);
          expect(prisma.studentInvite.create).not.toHaveBeenCalled();
          expect(emailSender.sendStudentInviteEmail).not.toHaveBeenCalled();
          expect(assertStudentCap).not.toHaveBeenCalled();
        });

        it('should report at least 1 second when the oldest counted invite is about to leave the window', async () => {
          prisma.studentInvite.findMany.mockResolvedValue(
            createdAtList(STUDENT_INVITE_DAILY_MAX, (i) => (i === STUDENT_INVITE_DAILY_MAX - 1 ? STUDENT_INVITE_DAILY_WINDOW_MS - 1 : 1000)),
          );

          await expect(inviteStudent(prisma, args(), { emailSender })).rejects.toMatchObject({
            details: { retryAfterSeconds: 1 },
          });
        });
      });

      it('should include canResend and resendAvailableAt on the returned invite', async () => {
        prisma.studentInvite.create.mockImplementation(async ({ data }) => makeInvite({ ...data, lastSentAt: NOW, sendCount: 1 }));

        const result = await inviteStudent(prisma, args(), { emailSender });

        expect(result.invite).toMatchObject({
          canResend: false,
          resendAvailableAt: new Date(NOW.getTime() + STUDENT_INVITE_RESEND_COOLDOWN_MS),
        });
      });

      it('should throw 409 studentInvite.alreadyPending when the partial unique index fires (P2002)', async () => {
        prisma.studentInvite.create.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));

        await expect(inviteStudent(prisma, args(), { emailSender })).rejects.toMatchObject({
          httpStatus: 409,
          error: StudentInviteErrorCode.ALREADY_PENDING,
          messageCode: StudentInviteMessageCode.ALREADY_PENDING,
        });
        expect(emailSender.sendStudentInviteEmail).not.toHaveBeenCalled();
      });

      it('should rethrow non-unique database errors untouched', async () => {
        const dbError = Object.assign(new Error('boom'), { code: 'P1001' });
        prisma.studentInvite.create.mockRejectedValue(dbError);

        await expect(inviteStudent(prisma, args(), { emailSender })).rejects.toBe(dbError);
      });

      it('should tolerate a non-string email by looking up an empty normalized value', async () => {
        await inviteStudent(prisma, { ...args(), email: undefined }, { emailSender });

        expect(findUserIdByEmailCaseInsensitive).toHaveBeenCalledWith(prisma, '');
      });
    });
  });

  describe('computeResendAvailability', () => {
    const sentAgo = (ms) => new Date(NOW.getTime() - ms);

    it('should allow resending a pending invite whose cooldown elapsed', () => {
      const invite = makeInvite({ lastSentAt: sentAgo(STUDENT_INVITE_RESEND_COOLDOWN_MS + 1) });

      expect(computeResendAvailability(invite)).toEqual({ canResend: true, resendAvailableAt: null });
    });

    it('should allow resending exactly when the cooldown ends', () => {
      const invite = makeInvite({ lastSentAt: sentAgo(STUDENT_INVITE_RESEND_COOLDOWN_MS) });

      expect(computeResendAvailability(invite)).toEqual({ canResend: true, resendAvailableAt: null });
    });

    it('should block during the cooldown and expose when it ends', () => {
      const lastSentAt = sentAgo(10 * MS_PER_MINUTE);

      expect(computeResendAvailability(makeInvite({ lastSentAt }))).toEqual({
        canResend: false,
        resendAvailableAt: new Date(lastSentAt.getTime() + STUDENT_INVITE_RESEND_COOLDOWN_MS),
      });
    });

    it('should treat a time-expired pending invite as resendable (it is revived on resend)', () => {
      const invite = makeInvite({ expiresAt: sentAgo(1000), lastSentAt: sentAgo(2 * STUDENT_INVITE_RESEND_COOLDOWN_MS) });

      expect(computeResendAvailability(invite)).toEqual({ canResend: true, resendAvailableAt: null });
    });

    it.each([StudentInviteStatus.ACCEPTED, StudentInviteStatus.REVOKED, StudentInviteStatus.EXPIRED])(
      'should never allow resending a %s invite, with no availability date',
      (status) => {
        const invite = makeInvite({ status, lastSentAt: sentAgo(10 * MS_PER_MINUTE) });

        expect(computeResendAvailability(invite)).toEqual({ canResend: false, resendAvailableAt: null });
      },
    );

    it('should never allow resending once the send cap is reached, with no availability date', () => {
      const invite = makeInvite({ sendCount: STUDENT_INVITE_MAX_SENDS, lastSentAt: sentAgo(3 * STUDENT_INVITE_RESEND_COOLDOWN_MS) });

      expect(computeResendAvailability(invite)).toEqual({ canResend: false, resendAvailableAt: null });
    });

    it('should still allow resending one send below the cap', () => {
      const invite = makeInvite({ sendCount: STUDENT_INVITE_MAX_SENDS - 1 });

      expect(computeResendAvailability(invite).canResend).toBe(true);
    });

    it('should default now to the current time', () => {
      const invite = makeInvite({ lastSentAt: NOW });

      expect(computeResendAvailability(invite).resendAvailableAt).toEqual(
        new Date(NOW.getTime() + STUDENT_INVITE_RESEND_COOLDOWN_MS),
      );
    });
  });

  describe('listStudentInvites', () => {
    beforeEach(() => {
      prisma.studentInvite.findMany.mockResolvedValue([]);
      prisma.studentInvite.count.mockResolvedValue(0);
    });

    it('should scope to the trainer and apply defaults without a status filter', async () => {
      const result = await listStudentInvites(prisma, { trainerId: TRAINER_ID });

      expect(prisma.studentInvite.findMany).toHaveBeenCalledWith({
        where: { trainerId: TRAINER_ID },
        orderBy: { createdAt: 'desc' },
        skip: 0,
        take: STUDENT_INVITE_LIST_PAGE_SIZE_DEFAULT,
      });
      expect(prisma.studentInvite.count).toHaveBeenCalledWith({ where: { trainerId: TRAINER_ID } });
      expect(result).toEqual({ items: [], total: 0, page: 1, pageSize: STUDENT_INVITE_LIST_PAGE_SIZE_DEFAULT });
    });

    it('should filter pending as not-yet-expired', async () => {
      await listStudentInvites(prisma, { trainerId: TRAINER_ID, status: StudentInviteStatus.PENDING });

      expect(prisma.studentInvite.findMany.mock.calls[0][0].where).toEqual({
        trainerId: TRAINER_ID,
        status: StudentInviteStatus.PENDING,
        expiresAt: { gte: NOW },
      });
    });

    it('should filter expired as stored-expired OR pending past expiry', async () => {
      await listStudentInvites(prisma, { trainerId: TRAINER_ID, status: StudentInviteStatus.EXPIRED });

      expect(prisma.studentInvite.findMany.mock.calls[0][0].where).toEqual({
        trainerId: TRAINER_ID,
        OR: [
          { status: StudentInviteStatus.EXPIRED },
          { status: StudentInviteStatus.PENDING, expiresAt: { lt: NOW } },
        ],
      });
    });

    it.each([StudentInviteStatus.ACCEPTED, StudentInviteStatus.REVOKED])(
      'should filter %s by stored status',
      async (status) => {
        await listStudentInvites(prisma, { trainerId: TRAINER_ID, status });

        expect(prisma.studentInvite.findMany.mock.calls[0][0].where).toEqual({ trainerId: TRAINER_ID, status });
      },
    );

    it('should ignore an unknown status value', async () => {
      await listStudentInvites(prisma, { trainerId: TRAINER_ID, status: 'bogus' });

      expect(prisma.studentInvite.findMany.mock.calls[0][0].where).toEqual({ trainerId: TRAINER_ID });
    });

    it('should report a pending invite past its expiry as expired without writing', async () => {
      const stale = makeInvite({ expiresAt: new Date(NOW.getTime() - 1000) });
      const fresh = makeInvite({ id: 'invite-2' });
      prisma.studentInvite.findMany.mockResolvedValue([stale, fresh]);
      prisma.studentInvite.count.mockResolvedValue(2);

      const result = await listStudentInvites(prisma, { trainerId: TRAINER_ID });

      expect(result.items.map((i) => i.status)).toEqual([StudentInviteStatus.EXPIRED, StudentInviteStatus.PENDING]);
      expect(prisma.studentInvite.updateMany).not.toHaveBeenCalled();
    });

    it('should attach canResend and resendAvailableAt to every listed invite', async () => {
      prisma.studentInvite.findMany.mockResolvedValue([
        makeInvite(),
        makeInvite({ id: 'invite-2', lastSentAt: NOW }),
        makeInvite({ id: 'invite-3', status: StudentInviteStatus.REVOKED }),
      ]);

      const result = await listStudentInvites(prisma, { trainerId: TRAINER_ID });

      expect(result.items.map((i) => [i.canResend, i.resendAvailableAt])).toEqual([
        [true, null],
        [false, new Date(NOW.getTime() + STUDENT_INVITE_RESEND_COOLDOWN_MS)],
        [false, null],
      ]);
    });

    it('should keep the stored status for non-pending invites', async () => {
      prisma.studentInvite.findMany.mockResolvedValue([
        makeInvite({ status: StudentInviteStatus.ACCEPTED, expiresAt: new Date(NOW.getTime() - 1000) }),
      ]);

      const result = await listStudentInvites(prisma, { trainerId: TRAINER_ID });

      expect(result.items[0].status).toBe(StudentInviteStatus.ACCEPTED);
    });

    it('should compute skip from page and pageSize', async () => {
      await listStudentInvites(prisma, { trainerId: TRAINER_ID, page: 3, pageSize: 10 });

      expect(prisma.studentInvite.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 20, take: 10 }));
    });

    it('should clamp page below 1 and pageSize above the max', async () => {
      const result = await listStudentInvites(prisma, { trainerId: TRAINER_ID, page: 0, pageSize: 5000 });

      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(STUDENT_INVITE_LIST_PAGE_SIZE_MAX);
    });

    it('should clamp pageSize below 1 to 1', async () => {
      const result = await listStudentInvites(prisma, { trainerId: TRAINER_ID, pageSize: -4 });

      expect(result.pageSize).toBe(1);
    });

    it('should fall back to defaults for non-finite page values', async () => {
      const result = await listStudentInvites(prisma, { trainerId: TRAINER_ID, page: NaN, pageSize: 'x' });

      expect(result).toMatchObject({ page: 1, pageSize: STUDENT_INVITE_LIST_PAGE_SIZE_DEFAULT });
    });
  });

  describe('resendStudentInvite', () => {
    const args = () => ({ trainerId: TRAINER_ID, trainerUserId: TRAINER_USER_ID, inviteId: INVITE_ID });

    beforeEach(() => {
      prisma.studentInvite.findFirst.mockResolvedValue(makeInvite());
      prisma.studentInvite.updateMany.mockResolvedValue({ count: 1 });
      prisma.studentInvite.findUnique.mockResolvedValue(makeInvite({ sendCount: 2, lastSentAt: NOW }));
    });

    it('should throw 404 studentInvite.notFound when the invite is not owned by the trainer', async () => {
      prisma.studentInvite.findFirst.mockResolvedValue(null);

      await expect(resendStudentInvite(prisma, args(), { emailSender })).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: StudentInviteMessageCode.NOT_FOUND,
      });
      expect(prisma.studentInvite.findFirst).toHaveBeenCalledWith({ where: { id: INVITE_ID, trainerId: TRAINER_ID } });
    });

    it.each([StudentInviteStatus.ACCEPTED, StudentInviteStatus.REVOKED, StudentInviteStatus.EXPIRED])(
      'should throw 409 studentInvite.notPending for a %s invite',
      async (status) => {
        prisma.studentInvite.findFirst.mockResolvedValue(makeInvite({ status }));

        await expect(resendStudentInvite(prisma, args(), { emailSender })).rejects.toMatchObject({
          httpStatus: 409,
          messageCode: StudentInviteMessageCode.NOT_PENDING,
        });
        expect(prisma.studentInvite.updateMany).not.toHaveBeenCalled();
      },
    );

    it('should throw 409 studentInvite.resendLimit when max sends reached', async () => {
      prisma.studentInvite.findFirst.mockResolvedValue(makeInvite({ sendCount: STUDENT_INVITE_MAX_SENDS }));

      await expect(resendStudentInvite(prisma, args(), { emailSender })).rejects.toMatchObject({
        httpStatus: 409,
        messageCode: StudentInviteMessageCode.RESEND_LIMIT,
      });
      expect(emailSender.sendStudentInviteEmail).not.toHaveBeenCalled();
    });

    it('should prefer the resend limit over the cooldown when both apply', async () => {
      prisma.studentInvite.findFirst.mockResolvedValue(
        makeInvite({ sendCount: STUDENT_INVITE_MAX_SENDS, lastSentAt: NOW }),
      );

      await expect(resendStudentInvite(prisma, args(), { emailSender })).rejects.toMatchObject({
        messageCode: StudentInviteMessageCode.RESEND_LIMIT,
      });
    });

    it('should throw 429 with retryAfterSeconds while the cooldown is active', async () => {
      const tenMinutesAgo = new Date(NOW.getTime() - 10 * MS_PER_MINUTE);
      prisma.studentInvite.findFirst.mockResolvedValue(makeInvite({ lastSentAt: tenMinutesAgo }));

      await expect(resendStudentInvite(prisma, args(), { emailSender })).rejects.toMatchObject({
        httpStatus: 429,
        error: StudentInviteErrorCode.RESEND_COOLDOWN,
        messageCode: StudentInviteMessageCode.RESEND_COOLDOWN,
        details: { retryAfterSeconds: 50 * 60 },
      });
      expect(prisma.studentInvite.updateMany).not.toHaveBeenCalled();
    });

    it('should report at least 1 second remaining just before the cooldown ends', async () => {
      prisma.studentInvite.findFirst.mockResolvedValue(
        makeInvite({ lastSentAt: new Date(NOW.getTime() - STUDENT_INVITE_RESEND_COOLDOWN_MS + 1) }),
      );

      await expect(resendStudentInvite(prisma, args(), { emailSender })).rejects.toMatchObject({
        details: { retryAfterSeconds: 1 },
      });
    });

    it('should allow the resend exactly when the cooldown has elapsed', async () => {
      prisma.studentInvite.findFirst.mockResolvedValue(
        makeInvite({ lastSentAt: new Date(NOW.getTime() - STUDENT_INVITE_RESEND_COOLDOWN_MS) }),
      );

      await expect(resendStudentInvite(prisma, args(), { emailSender })).resolves.toBeDefined();
    });

    it('should apply a guarded updateMany that renews expiry, lastSentAt and increments sendCount', async () => {
      await resendStudentInvite(prisma, args(), { emailSender });

      expect(prisma.studentInvite.updateMany).toHaveBeenCalledWith({
        where: {
          id: INVITE_ID,
          status: StudentInviteStatus.PENDING,
          sendCount: { lt: STUDENT_INVITE_MAX_SENDS },
          lastSentAt: { lte: new Date(NOW.getTime() - STUDENT_INVITE_RESEND_COOLDOWN_MS) },
        },
        data: {
          expiresAt: new Date(NOW.getTime() + STUDENT_INVITE_TTL_MS),
          lastSentAt: NOW,
          sendCount: { increment: 1 },
        },
      });
    });

    it('should revive a pending invite that is past its expiry and report it as pending', async () => {
      prisma.studentInvite.findFirst.mockResolvedValue(makeInvite({ expiresAt: new Date(NOW.getTime() - 1000) }));
      prisma.studentInvite.findUnique.mockResolvedValue(
        makeInvite({ sendCount: 2, lastSentAt: NOW, expiresAt: new Date(NOW.getTime() + STUDENT_INVITE_TTL_MS) }),
      );

      const result = await resendStudentInvite(prisma, args(), { emailSender });

      expect(result.status).toBe(StudentInviteStatus.PENDING);
      expect(emailSender.sendStudentInviteEmail).toHaveBeenCalledWith({ to: STUDENT_EMAIL, trainerName: 'Ana Coach' });
    });

    it('should throw the cooldown error when a concurrent resend won the race (count 0)', async () => {
      prisma.studentInvite.updateMany.mockResolvedValue({ count: 0 });
      prisma.studentInvite.findFirst
        .mockResolvedValueOnce(makeInvite())
        .mockResolvedValueOnce(makeInvite({ sendCount: 2, lastSentAt: NOW }));

      await expect(resendStudentInvite(prisma, args(), { emailSender })).rejects.toMatchObject({
        httpStatus: 429,
        messageCode: StudentInviteMessageCode.RESEND_COOLDOWN,
        details: { retryAfterSeconds: STUDENT_INVITE_RESEND_COOLDOWN_MS / 1000 },
      });
      expect(emailSender.sendStudentInviteEmail).not.toHaveBeenCalled();
    });

    it('should throw 409 notPending when the invite was accepted or revoked concurrently (count 0)', async () => {
      prisma.studentInvite.updateMany.mockResolvedValue({ count: 0 });
      prisma.studentInvite.findFirst
        .mockResolvedValueOnce(makeInvite())
        .mockResolvedValueOnce(makeInvite({ status: StudentInviteStatus.ACCEPTED }));

      await expect(resendStudentInvite(prisma, args(), { emailSender })).rejects.toMatchObject({
        httpStatus: 409,
        messageCode: StudentInviteMessageCode.NOT_PENDING,
      });
      expect(emailSender.sendStudentInviteEmail).not.toHaveBeenCalled();
    });

    describe('when the email delivery fails', () => {
      it.each([
        ['a thrown error', (fn) => fn.mockRejectedValue(new Error('resend down'))],
        ['a returned Resend error', (fn) => fn.mockResolvedValue({ data: null, error: { message: 'rejected' } })],
      ])('should throw 502 studentInvite.emailSendFailed on %s', async (_label, arrange) => {
        arrange(emailSender.sendStudentInviteEmail);

        await expect(resendStudentInvite(prisma, args(), { emailSender })).rejects.toMatchObject({
          httpStatus: 502,
          error: StudentInviteErrorCode.EMAIL_SEND_FAILED,
          messageCode: StudentInviteMessageCode.EMAIL_SEND_FAILED,
        });
        expect(console.error).toHaveBeenCalled();
      });

      it('should roll back the bookkeeping conditioned on the resend timestamp', async () => {
        const previous = makeInvite();
        prisma.studentInvite.findFirst.mockResolvedValue(previous);
        emailSender.sendStudentInviteEmail.mockRejectedValue(new Error('resend down'));

        await expect(resendStudentInvite(prisma, args(), { emailSender })).rejects.toBeDefined();

        expect(prisma.studentInvite.updateMany).toHaveBeenLastCalledWith({
          where: { id: INVITE_ID, status: StudentInviteStatus.PENDING, lastSentAt: NOW },
          data: {
            expiresAt: previous.expiresAt,
            lastSentAt: previous.lastSentAt,
            sendCount: { decrement: 1 },
          },
        });
      });

      it('should still throw 502 when the rollback itself fails', async () => {
        prisma.studentInvite.updateMany
          .mockResolvedValueOnce({ count: 1 })
          .mockRejectedValueOnce(new Error('db down'));
        emailSender.sendStudentInviteEmail.mockRejectedValue(new Error('resend down'));

        await expect(resendStudentInvite(prisma, args(), { emailSender })).rejects.toMatchObject({ httpStatus: 502 });
      });

      it('should not roll back when the email is delivered', async () => {
        await resendStudentInvite(prisma, args(), { emailSender });

        expect(prisma.studentInvite.updateMany).toHaveBeenCalledTimes(1);
      });
    });

    describe('when the invite email belongs to an existing user with an unverified email', () => {
      const STUDENT_USER_ID = 'user-9';

      beforeEach(() => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        findUserIdByEmailCaseInsensitive.mockResolvedValue(STUDENT_USER_ID);
        prisma.account.findFirst.mockResolvedValue(null);
        prisma.user.findUnique.mockImplementation(async ({ where }) =>
          where.id === STUDENT_USER_ID
            ? { deletedAt: null }
            : { firstName: 'Ana', lastName: 'Coach' },
        );
      });

      it('should send the existing-user variant with an issued code instead of the generic email', async () => {
        await resendStudentInvite(prisma, args(), { emailSender });

        expect(issueCodeRespectingLimits).toHaveBeenCalledWith(prisma, STUDENT_USER_ID);
        expect(emailSender.sendExistingUserStudentInviteEmail).toHaveBeenCalledWith({
          to: STUDENT_EMAIL,
          trainerName: 'Ana Coach',
          code: ISSUED_CODE,
        });
        expect(emailSender.sendStudentInviteEmail).not.toHaveBeenCalled();
      });

      it('should close older codes only after the variant email is delivered', async () => {
        await resendStudentInvite(prisma, args(), { emailSender });

        expect(confirmVerificationCodeDelivered).toHaveBeenCalledWith(prisma, ISSUED);
        expect(markVerificationSendFailed).not.toHaveBeenCalled();
      });

      it('should send the variant with code null and still succeed when issuing is blocked', async () => {
        issueCodeRespectingLimits.mockRejectedValue(
          new AppError({ httpStatus: 429, error: 'X', messageCode: 'x.y', message: 'blocked' }),
        );

        await expect(resendStudentInvite(prisma, args(), { emailSender })).resolves.toBeDefined();

        expect(emailSender.sendExistingUserStudentInviteEmail).toHaveBeenCalledWith({
          to: STUDENT_EMAIL,
          trainerName: 'Ana Coach',
          code: null,
        });
        expect(confirmVerificationCodeDelivered).not.toHaveBeenCalled();
      });

      it('should not fail the resend when code issuing throws an unexpected error', async () => {
        issueCodeRespectingLimits.mockRejectedValue(new Error('db down'));

        await expect(resendStudentInvite(prisma, args(), { emailSender })).resolves.toBeDefined();
        expect(emailSender.sendExistingUserStudentInviteEmail).toHaveBeenCalledTimes(1);
      });

      it.each([
        ['a thrown error', (fn) => fn.mockRejectedValue(new Error('resend down'))],
        ['a returned Resend error', (fn) => fn.mockResolvedValue({ data: null, error: { message: 'rejected' } })],
      ])('should throw 502, mark the issued code undelivered and roll back bookkeeping on %s', async (_label, arrange) => {
        arrange(emailSender.sendExistingUserStudentInviteEmail);

        await expect(resendStudentInvite(prisma, args(), { emailSender })).rejects.toMatchObject({
          httpStatus: 502,
          messageCode: StudentInviteMessageCode.EMAIL_SEND_FAILED,
        });
        expect(markVerificationSendFailed).toHaveBeenCalledWith(prisma, ISSUED_TOKEN_ID);
        expect(confirmVerificationCodeDelivered).not.toHaveBeenCalled();
        expect(prisma.studentInvite.updateMany).toHaveBeenLastCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ sendCount: { decrement: 1 } }) }),
        );
      });

      it('should throw 502 without marking any code when the email fails and no code was issued', async () => {
        issueCodeRespectingLimits.mockRejectedValue(new Error('blocked'));
        emailSender.sendExistingUserStudentInviteEmail.mockRejectedValue(new Error('resend down'));

        await expect(resendStudentInvite(prisma, args(), { emailSender })).rejects.toMatchObject({ httpStatus: 502 });
        expect(markVerificationSendFailed).not.toHaveBeenCalled();
      });
    });

    describe('when the invite email does not need a verification code', () => {
      const OWNER_ID = 'user-9';

      it('should send the generic email when the existing user is already verified', async () => {
        findUserIdByEmailCaseInsensitive.mockResolvedValue(OWNER_ID);
        prisma.user.findUnique.mockImplementation(async ({ where }) =>
          where.id === OWNER_ID ? { deletedAt: null } : { firstName: 'Ana', lastName: 'Coach' },
        );
        prisma.account.findFirst.mockResolvedValue({ id: 'acc-verified' });

        await resendStudentInvite(prisma, args(), { emailSender });

        expect(emailSender.sendStudentInviteEmail).toHaveBeenCalledTimes(1);
        expect(emailSender.sendExistingUserStudentInviteEmail).not.toHaveBeenCalled();
        expect(issueCodeRespectingLimits).not.toHaveBeenCalled();
      });

      it('should send the generic email when the existing user is soft-deleted', async () => {
        findUserIdByEmailCaseInsensitive.mockResolvedValue(OWNER_ID);
        prisma.user.findUnique.mockImplementation(async ({ where }) =>
          where.id === OWNER_ID ? { deletedAt: new Date() } : { firstName: 'Ana', lastName: 'Coach' },
        );
        prisma.account.findFirst.mockResolvedValue(null);

        await resendStudentInvite(prisma, args(), { emailSender });

        expect(emailSender.sendStudentInviteEmail).toHaveBeenCalledTimes(1);
        expect(issueCodeRespectingLimits).not.toHaveBeenCalled();
      });

      it('should send the generic email when no user owns the email', async () => {
        await resendStudentInvite(prisma, args(), { emailSender });

        expect(emailSender.sendStudentInviteEmail).toHaveBeenCalledTimes(1);
        expect(issueCodeRespectingLimits).not.toHaveBeenCalled();
      });

      it('should fall back to the generic email when the recipient lookup fails', async () => {
        findUserIdByEmailCaseInsensitive.mockRejectedValue(new Error('db down'));

        await expect(resendStudentInvite(prisma, args(), { emailSender })).resolves.toBeDefined();
        expect(emailSender.sendStudentInviteEmail).toHaveBeenCalledTimes(1);
      });
    });

    it('should return canResend false with resendAvailableAt one cooldown after the fresh send', async () => {
      const result = await resendStudentInvite(prisma, args(), { emailSender });

      expect(result).toMatchObject({
        canResend: false,
        resendAvailableAt: new Date(NOW.getTime() + STUDENT_INVITE_RESEND_COOLDOWN_MS),
      });
    });
  });

  describe('revokeStudentInvite', () => {
    const args = () => ({ trainerId: TRAINER_ID, inviteId: INVITE_ID });

    it('should conditionally flip a pending invite to revoked and return it', async () => {
      prisma.studentInvite.updateMany.mockResolvedValue({ count: 1 });
      prisma.studentInvite.findUnique.mockResolvedValue(
        makeInvite({ status: StudentInviteStatus.REVOKED, revokedAt: NOW }),
      );

      const result = await revokeStudentInvite(prisma, args());

      expect(prisma.studentInvite.updateMany).toHaveBeenCalledWith({
        where: { id: INVITE_ID, trainerId: TRAINER_ID, status: StudentInviteStatus.PENDING },
        data: { status: StudentInviteStatus.REVOKED, revokedAt: NOW },
      });
      expect(result.status).toBe(StudentInviteStatus.REVOKED);
      expect(result).toMatchObject({ canResend: false, resendAvailableAt: null });
    });

    it('should throw 404 studentInvite.notFound when the invite is missing or not owned', async () => {
      prisma.studentInvite.updateMany.mockResolvedValue({ count: 0 });
      prisma.studentInvite.findFirst.mockResolvedValue(null);

      await expect(revokeStudentInvite(prisma, args())).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: StudentInviteMessageCode.NOT_FOUND,
      });
    });

    it('should throw 409 studentInvite.notPending when the invite exists but is no longer pending (accept race)', async () => {
      prisma.studentInvite.updateMany.mockResolvedValue({ count: 0 });
      prisma.studentInvite.findFirst.mockResolvedValue(makeInvite({ status: StudentInviteStatus.ACCEPTED }));

      await expect(revokeStudentInvite(prisma, args())).rejects.toMatchObject({
        httpStatus: 409,
        messageCode: StudentInviteMessageCode.NOT_PENDING,
      });
    });
  });

  describe('acceptPendingInvitesForUser', () => {
    const user = { id: 'student-1', email: 'Student@Example.com' };
    const pending = (overrides = {}) => ({
      id: INVITE_ID,
      trainerId: TRAINER_ID,
      expiresAt: new Date(NOW.getTime() + STUDENT_INVITE_TTL_MS),
      ...overrides,
    });

    beforeEach(() => {
      prisma.studentInvite.updateMany.mockResolvedValue({ count: 1 });
      prisma.trainerStudent.createMany.mockResolvedValue({ count: 1 });
    });

    it.each([
      ['no user', null],
      ['a user without id', { email: STUDENT_EMAIL }],
      ['a user without email', { id: 'student-1' }],
      ['a user with a blank email', { id: 'student-1', email: '   ' }],
    ])('should return 0 without querying for %s', async (_label, input) => {
      await expect(acceptPendingInvitesForUser(prisma, input)).resolves.toBe(0);
      expect(prisma.studentInvite.findMany).not.toHaveBeenCalled();
    });

    it('should query pending invites by the normalized email', async () => {
      prisma.studentInvite.findMany.mockResolvedValue([]);

      await acceptPendingInvitesForUser(prisma, user);

      expect(prisma.studentInvite.findMany).toHaveBeenCalledWith({
        where: { email: STUDENT_EMAIL, status: StudentInviteStatus.PENDING },
        select: { id: true, trainerId: true, expiresAt: true },
      });
    });

    it('should claim the invite, link the student, and notify onboarding and briefing', async () => {
      prisma.studentInvite.findMany.mockResolvedValue([pending()]);

      const accepted = await acceptPendingInvitesForUser(prisma, user);

      expect(accepted).toBe(1);
      expect(prisma.studentInvite.updateMany).toHaveBeenCalledWith({
        where: { id: INVITE_ID, status: StudentInviteStatus.PENDING },
        data: { status: StudentInviteStatus.ACCEPTED, studentId: 'student-1', acceptedAt: NOW },
      });
      expect(prisma.trainerStudent.createMany).toHaveBeenCalledWith({
        data: [{ trainerId: TRAINER_ID, studentId: 'student-1', activeOnPlan: true }],
        skipDuplicates: true,
      });
      expect(maybeMarkFirstStudentLinked).toHaveBeenCalledWith({ trainerId: TRAINER_ID, tx: prisma });
      expect(markBriefingDirty).toHaveBeenCalledWith(prisma, TRAINER_ID);
    });

    it('should mark the student user active when the invite is accepted', async () => {
      prisma.studentInvite.findMany.mockResolvedValue([pending()]);
      prisma.user.update.mockResolvedValue({});
      prisma.user.updateMany.mockResolvedValue({ count: 1 });

      await acceptPendingInvitesForUser(prisma, user);

      expect(userStatusWrites(prisma)).toEqual([
        expect.objectContaining({
          where: expect.objectContaining({ id: 'student-1' }),
          data: { status: ACTIVE_USER_STATUS },
        }),
      ]);
    });

    it('should not mark the user active when the invite was no longer pending (claim lost)', async () => {
      prisma.studentInvite.findMany.mockResolvedValue([pending()]);
      prisma.studentInvite.updateMany.mockResolvedValue({ count: 0 });

      await acceptPendingInvitesForUser(prisma, user);

      expect(userStatusWrites(prisma)).toEqual([]);
    });

    it('should still mark the user active when the link is created inactive over the plan cap', async () => {
      prisma.studentInvite.findMany.mockResolvedValue([pending()]);
      prisma.user.update.mockResolvedValue({});
      prisma.user.updateMany.mockResolvedValue({ count: 1 });
      assertStudentCap.mockRejectedValue(capExceededError());

      await acceptPendingInvitesForUser(prisma, user);

      expect(prisma.trainerStudent.createMany).toHaveBeenCalledWith({
        data: [{ trainerId: TRAINER_ID, studentId: 'student-1', activeOnPlan: false }],
        skipDuplicates: true,
      });
      expect(userStatusWrites(prisma)).toEqual([
        expect.objectContaining({ data: { status: ACTIVE_USER_STATUS } }),
      ]);
    });

    it('should accept invites from multiple trainers independently', async () => {
      prisma.studentInvite.findMany.mockResolvedValue([
        pending({ id: 'i1', trainerId: 'trainer-A' }),
        pending({ id: 'i2', trainerId: 'trainer-B' }),
      ]);

      const accepted = await acceptPendingInvitesForUser(prisma, user);

      expect(accepted).toBe(2);
      expect(prisma.trainerStudent.createMany).toHaveBeenCalledTimes(2);
      expect(markBriefingDirty).toHaveBeenCalledWith(prisma, 'trainer-A');
      expect(markBriefingDirty).toHaveBeenCalledWith(prisma, 'trainer-B');
    });

    it('should create the link inactive (activeOnPlan false) when the trainer is over the student cap', async () => {
      prisma.studentInvite.findMany.mockResolvedValue([pending()]);
      assertStudentCap.mockRejectedValue(capExceededError());

      const accepted = await acceptPendingInvitesForUser(prisma, user);

      expect(accepted).toBe(1);
      expect(prisma.trainerStudent.createMany).toHaveBeenCalledWith({
        data: [{ trainerId: TRAINER_ID, studentId: 'student-1', activeOnPlan: false }],
        skipDuplicates: true,
      });
    });

    it('should skip that invite (and keep going) when the cap check fails for an unexpected reason', async () => {
      prisma.studentInvite.findMany.mockResolvedValue([pending({ id: 'i1' }), pending({ id: 'i2', trainerId: 'trainer-B' })]);
      assertStudentCap.mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce(undefined);

      const accepted = await acceptPendingInvitesForUser(prisma, user);

      expect(accepted).toBe(1);
      expect(prisma.trainerStudent.createMany).toHaveBeenCalledTimes(1);
      expect(console.error).toHaveBeenCalled();
    });

    it('should flip an expired pending invite to expired and not link', async () => {
      prisma.studentInvite.findMany.mockResolvedValue([pending({ expiresAt: new Date(NOW.getTime() - 1000) })]);

      const accepted = await acceptPendingInvitesForUser(prisma, user);

      expect(accepted).toBe(0);
      expect(prisma.studentInvite.updateMany).toHaveBeenCalledWith({
        where: { id: INVITE_ID, status: StudentInviteStatus.PENDING, expiresAt: { lt: expect.any(Date) } },
        data: { status: StudentInviteStatus.EXPIRED },
      });
      expect(prisma.trainerStudent.createMany).not.toHaveBeenCalled();
      expect(assertStudentCap).not.toHaveBeenCalled();
    });

    it('should not link or count the invite when it was revoked concurrently (claim count 0)', async () => {
      prisma.studentInvite.findMany.mockResolvedValue([pending()]);
      prisma.studentInvite.updateMany.mockResolvedValue({ count: 0 });

      const accepted = await acceptPendingInvitesForUser(prisma, user);

      expect(accepted).toBe(0);
      expect(prisma.trainerStudent.createMany).not.toHaveBeenCalled();
      expect(maybeMarkFirstStudentLinked).not.toHaveBeenCalled();
      expect(markBriefingDirty).not.toHaveBeenCalled();
    });

    it('should isolate a failing invite and still accept the next one', async () => {
      prisma.studentInvite.findMany.mockResolvedValue([pending({ id: 'i1' }), pending({ id: 'i2', trainerId: 'trainer-B' })]);
      prisma.$transaction.mockRejectedValueOnce(new Error('tx failed'));

      const accepted = await acceptPendingInvitesForUser(prisma, user);

      expect(accepted).toBe(1);
      expect(console.error).toHaveBeenCalled();
    });

    it('should not fail the accept when post-link side effects throw', async () => {
      prisma.studentInvite.findMany.mockResolvedValue([pending()]);
      markBriefingDirty.mockRejectedValue(new Error('briefing down'));

      await expect(acceptPendingInvitesForUser(prisma, user)).resolves.toBe(0);
    });

    it('should swallow lookup failures and return 0', async () => {
      prisma.studentInvite.findMany.mockRejectedValue(new Error('db down'));

      await expect(acceptPendingInvitesForUser(prisma, user)).resolves.toBe(0);
      expect(console.error).toHaveBeenCalled();
    });
  });
});
