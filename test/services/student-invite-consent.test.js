import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/db.js', () => ({ prisma: {} }));
vi.mock('../../src/config/email-handler.js', () => ({
  default: {
    sendStudentInviteEmail: vi.fn(),
    sendExistingUserStudentInviteEmail: vi.fn(),
    sendStudentInviteOpenAppEmail: vi.fn(),
    sendEmailVerificationEmail: vi.fn(),
  },
}));
vi.mock('../../src/services/platform-plan-service.js', async (importOriginal) => ({
  ...(await importOriginal()),
  assertStudentCap: vi.fn(),
}));
vi.mock('../../src/services/trainer-service.js', async (importOriginal) => ({
  ...(await importOriginal()),
  linkStudentByEmail: vi.fn(),
}));
vi.mock('../../src/services/trainer-onboarding-service.js', async (importOriginal) => ({
  ...(await importOriginal()),
  maybeMarkFirstStudentLinked: vi.fn(),
  maybeMarkFirstStudentInvited: vi.fn(),
}));
vi.mock('../../src/services/briefing-service.js', async (importOriginal) => ({
  ...(await importOriginal()),
  markBriefingDirty: vi.fn(),
}));
vi.mock('../../src/services/challenge-participant-sync.js', async (importOriginal) => ({
  ...(await importOriginal()),
  joinAllModeChallenges: vi.fn(),
}));
vi.mock('../../src/services/email-verification-service.js', async (importOriginal) => ({
  ...(await importOriginal()),
  issueCodeRespectingLimits: vi.fn(),
}));

import { AppError } from '../../src/errors/app-error.js';
import { PLATFORM_PLAN_ERRORS } from '../../src/constants/platform-plan.js';
import { EMAIL_PROVIDER } from '../../src/constants/email-verification.js';
import {
  StudentInviteStatus,
  StudentInviteOutcome,
  StudentInviteErrorCode,
  StudentInviteMessageCode,
  STUDENT_INVITE_DAILY_MAX,
  STUDENT_INVITE_RESEND_COOLDOWN_MS,
  STUDENT_INVITE_TTL_MS,
} from '../../src/constants/student-invite.js';
import { assertStudentCap } from '../../src/services/platform-plan-service.js';
import { linkStudentByEmail } from '../../src/services/trainer-service.js';
import { maybeMarkFirstStudentLinked } from '../../src/services/trainer-onboarding-service.js';
import { issueCodeRespectingLimits } from '../../src/services/email-verification-service.js';
import {
  inviteStudent,
  resendStudentInvite,
  acceptPendingInvitesForUser,
} from '../../src/services/student-invite-service.js';
import { createInviteConsentWorld } from '../helpers/student-invite-consent-world.js';

const NOW = new Date('2026-11-19T12:00:00.000Z');
const MS_PER_MINUTE = 60 * 1000;
const UNVERIFIED_SENDER_INVITE_CAP = 3;
const TRAINER_ID = 'trainer-1';
const OTHER_TRAINER_ID = 'trainer-2';
const TRAINER_USER_ID = 'trainer-user-1';
const OTHER_TRAINER_USER_ID = 'trainer-user-2';
const TRAINER_NAME = 'Ana Coach';
const STUDENT_ID = 'student-1';
const STORED_STUDENT_EMAIL = 'Student@Example.com';
const STUDENT_EMAIL = 'student@example.com';
const UNKNOWN_EMAIL = 'nobody@example.com';
const INVITE_ID = 'invite-1';
const DELIVERED = { data: { id: 'message-1' } };
const EMAIL_VERIFICATION_REQUIRED = Object.freeze({
  httpStatus: 403,
  error: 'EMAIL_VERIFICATION_REQUIRED',
  messageCode: 'emailVerification.required',
});
const ACCOUNT_STATES = [
  ['a verified e-mail', true],
  ['an unverified e-mail', false],
];

// Builds an e-mail account row, verified or not.
function makeAccount(userId, verified) {
  return { id: `account-${userId}`, userId, provider: EMAIL_PROVIDER, verifiedAt: verified ? new Date('2026-11-01T00:00:00.000Z') : null };
}

// Builds the world of one trainer and, unless told otherwise, one existing student account.
function makeWorld({ studentVerified = true, senderVerified = true, studentDeletedAt = null, withStudent = true, invites = [], links = [] } = {}) {
  const trainerUser = { id: TRAINER_USER_ID, email: 'coach@example.com', firstName: 'Ana', lastName: 'Coach', deletedAt: null };
  const otherTrainerUser = { id: OTHER_TRAINER_USER_ID, email: 'other@example.com', firstName: 'Bia', lastName: 'Lima', deletedAt: null };
  const student = { id: STUDENT_ID, email: STORED_STUDENT_EMAIL, firstName: 'Caio', lastName: 'Souza', status: 'active', deletedAt: studentDeletedAt };
  return createInviteConsentWorld({
    users: [trainerUser, otherTrainerUser, ...(withStudent ? [student] : [])],
    accounts: [
      makeAccount(TRAINER_USER_ID, senderVerified),
      makeAccount(OTHER_TRAINER_USER_ID, true),
      ...(withStudent ? [makeAccount(STUDENT_ID, studentVerified)] : []),
    ],
    trainers: [
      { id: TRAINER_ID, userId: TRAINER_USER_ID, deletedAt: null },
      { id: OTHER_TRAINER_ID, userId: OTHER_TRAINER_USER_ID, deletedAt: null },
    ],
    invites,
    links,
  });
}

// Builds a stored pending invite of the trainer that is old enough to be resent.
function makeInvite(overrides = {}) {
  const sentAt = new Date(NOW.getTime() - STUDENT_INVITE_RESEND_COOLDOWN_MS - MS_PER_MINUTE);
  return {
    id: INVITE_ID,
    trainerId: TRAINER_ID,
    email: STUDENT_EMAIL,
    status: StudentInviteStatus.PENDING,
    requiresConsent: true,
    expiresAt: new Date(NOW.getTime() + STUDENT_INVITE_TTL_MS),
    lastSentAt: sentAt,
    createdAt: sentAt,
    sendCount: 1,
    ...overrides,
  };
}

// Builds invites the trainer already sent to other addresses a minute ago.
function recentInvites(count) {
  return Array.from({ length: count }, (_unused, index) =>
    makeInvite({
      id: `seeded-${index}`,
      email: `seeded-${index}@example.com`,
      requiresConsent: false,
      createdAt: new Date(NOW.getTime() - MS_PER_MINUTE),
      lastSentAt: new Date(NOW.getTime() - MS_PER_MINUTE),
    }),
  );
}

// Builds the error the plan service throws when the trainer is over the student cap.
function capExceededError() {
  return new AppError({
    httpStatus: PLATFORM_PLAN_ERRORS.STUDENT_CAP_EXCEEDED.status,
    error: PLATFORM_PLAN_ERRORS.STUDENT_CAP_EXCEEDED.code,
    messageCode: PLATFORM_PLAN_ERRORS.STUDENT_CAP_EXCEEDED.messageCode,
    message: 'cap',
  });
}

// Builds an injected e-mail sender whose every send succeeds.
function makeEmailSender() {
  return {
    sendStudentInviteEmail: vi.fn().mockResolvedValue(DELIVERED),
    sendExistingUserStudentInviteEmail: vi.fn().mockResolvedValue(DELIVERED),
    sendStudentInviteOpenAppEmail: vi.fn().mockResolvedValue(DELIVERED),
  };
}

describe('student invites that need the consent of an existing account', () => {
  let emailSender;

  const invite = (prisma, email = STUDENT_EMAIL) =>
    inviteStudent(prisma, { trainerId: TRAINER_ID, trainerUserId: TRAINER_USER_ID, email }, { emailSender });
  const resend = (prisma) =>
    resendStudentInvite(prisma, { trainerId: TRAINER_ID, trainerUserId: TRAINER_USER_ID, inviteId: INVITE_ID }, { emailSender });
  const invitesFor = (state, email) => state.studentInvites.filter((row) => row.email === email);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    emailSender = makeEmailSender();
    assertStudentCap.mockResolvedValue(undefined);
    linkStudentByEmail.mockResolvedValue({ id: STUDENT_ID, email: STORED_STUDENT_EMAIL });
    issueCodeRespectingLimits.mockResolvedValue({ code: '123456', tokenId: 'token-1', userId: STUDENT_ID, createdAt: NOW });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe.each(ACCOUNT_STATES)('inviteStudent for an existing account with %s', (_label, studentVerified) => {
    it('should answer outcome invited with a pending invite for the normalized e-mail', async () => {
      const { prisma } = makeWorld({ studentVerified });

      const result = await invite(prisma, `  ${STORED_STUDENT_EMAIL} `);

      expect(result.outcome).toBe(StudentInviteOutcome.INVITED);
      expect(result.invite).toMatchObject({ email: STUDENT_EMAIL, status: StudentInviteStatus.PENDING });
      expect(result).not.toHaveProperty('student');
    });

    it('should store the invite with requiresConsent true', async () => {
      const { prisma, state } = makeWorld({ studentVerified });

      await invite(prisma);

      expect(invitesFor(state, STUDENT_EMAIL)).toHaveLength(1);
      expect(invitesFor(state, STUDENT_EMAIL)[0]).toMatchObject({
        trainerId: TRAINER_ID,
        status: StudentInviteStatus.PENDING,
        requiresConsent: true,
      });
    });

    it('should create no trainer-student link', async () => {
      const { prisma, state } = makeWorld({ studentVerified });

      await invite(prisma);

      expect(state.trainerStudents).toEqual([]);
      expect(linkStudentByEmail).not.toHaveBeenCalled();
    });

    it('should send one "open the app" e-mail with the recipient and the trainer name', async () => {
      const { prisma } = makeWorld({ studentVerified });

      await invite(prisma);

      expect(emailSender.sendStudentInviteOpenAppEmail).toHaveBeenCalledTimes(1);
      expect(emailSender.sendStudentInviteOpenAppEmail).toHaveBeenCalledWith({ to: STUDENT_EMAIL, trainerName: TRAINER_NAME });
    });

    it('should send neither the verification-code variant nor the download e-mail', async () => {
      const { prisma } = makeWorld({ studentVerified });

      await invite(prisma);

      expect(emailSender.sendExistingUserStudentInviteEmail).not.toHaveBeenCalled();
      expect(emailSender.sendStudentInviteEmail).not.toHaveBeenCalled();
    });

    it('should issue no verification code for the invited account', async () => {
      const { prisma } = makeWorld({ studentVerified });

      await invite(prisma);

      expect(issueCodeRespectingLimits).not.toHaveBeenCalled();
    });

    it('should still answer invited when the e-mail provider fails', async () => {
      const { prisma, state } = makeWorld({ studentVerified });
      emailSender.sendStudentInviteOpenAppEmail.mockRejectedValue(new AppError({ httpStatus: 502, error: 'PROVIDER_DOWN', messageCode: 'provider.down', message: 'down' }));

      const result = await invite(prisma);

      expect(result.outcome).toBe(StudentInviteOutcome.INVITED);
      expect(invitesFor(state, STUDENT_EMAIL)).toHaveLength(1);
    });

    it('should reject with 409 student.alreadyLinked and create nothing when the student is already linked', async () => {
      const { prisma, state } = makeWorld({ studentVerified, links: [{ trainerId: TRAINER_ID, studentId: STUDENT_ID, activeOnPlan: true }] });

      await expect(invite(prisma)).rejects.toMatchObject({ httpStatus: 409, messageCode: StudentInviteMessageCode.ALREADY_LINKED });
      expect(state.studentInvites).toEqual([]);
      expect(emailSender.sendStudentInviteOpenAppEmail).not.toHaveBeenCalled();
    });

    it('should still invite when the student is linked to another trainer only', async () => {
      const { prisma, state } = makeWorld({ studentVerified, links: [{ trainerId: OTHER_TRAINER_ID, studentId: STUDENT_ID, activeOnPlan: true }] });

      const result = await invite(prisma);

      expect(result.outcome).toBe(StudentInviteOutcome.INVITED);
      expect(state.trainerStudents).toHaveLength(1);
    });

    it('should reject the 4th invite of an unverified sender with 403 emailVerification.required and create nothing', async () => {
      const { prisma, state } = makeWorld({ studentVerified, senderVerified: false, invites: recentInvites(UNVERIFIED_SENDER_INVITE_CAP) });

      await expect(invite(prisma)).rejects.toMatchObject(EMAIL_VERIFICATION_REQUIRED);
      expect(invitesFor(state, STUDENT_EMAIL)).toEqual([]);
      expect(emailSender.sendStudentInviteOpenAppEmail).not.toHaveBeenCalled();
    });

    it('should count the consent invite itself towards the unverified-sender allowance', async () => {
      const { prisma } = makeWorld({ studentVerified, senderVerified: false, invites: recentInvites(UNVERIFIED_SENDER_INVITE_CAP - 1) });

      await invite(prisma);

      await expect(invite(prisma, UNKNOWN_EMAIL)).rejects.toMatchObject(EMAIL_VERIFICATION_REQUIRED);
    });

    it('should reject with 429 studentInvite.dailyLimit once the daily cap is reached', async () => {
      const { prisma, state } = makeWorld({ studentVerified, invites: recentInvites(STUDENT_INVITE_DAILY_MAX) });

      await expect(invite(prisma)).rejects.toMatchObject({
        httpStatus: 429,
        error: StudentInviteErrorCode.DAILY_LIMIT,
        messageCode: StudentInviteMessageCode.DAILY_LIMIT,
      });
      expect(invitesFor(state, STUDENT_EMAIL)).toEqual([]);
    });

    it('should apply the plan student cap and create nothing when it is exceeded', async () => {
      const { prisma, state } = makeWorld({ studentVerified });
      assertStudentCap.mockRejectedValue(capExceededError());

      await expect(invite(prisma)).rejects.toMatchObject({
        httpStatus: PLATFORM_PLAN_ERRORS.STUDENT_CAP_EXCEEDED.status,
        error: PLATFORM_PLAN_ERRORS.STUDENT_CAP_EXCEEDED.code,
      });
      expect(assertStudentCap).toHaveBeenCalledWith(prisma, TRAINER_ID);
      expect(state.studentInvites).toEqual([]);
      expect(emailSender.sendStudentInviteOpenAppEmail).not.toHaveBeenCalled();
    });

    it('should keep rejecting a deactivated account with 422 student.accountDeactivated', async () => {
      const { prisma, state } = makeWorld({ studentVerified, studentDeletedAt: new Date('2026-11-10T00:00:00.000Z') });

      await expect(invite(prisma)).rejects.toMatchObject({
        httpStatus: 422,
        error: StudentInviteErrorCode.STUDENT_ACCOUNT_DEACTIVATED,
        messageCode: StudentInviteMessageCode.STUDENT_ACCOUNT_DEACTIVATED,
      });
      expect(state.studentInvites).toEqual([]);
    });
  });

  describe('inviteStudent edge cases', () => {
    it('should keep rejecting the own e-mail of the trainer with 422 student.cannotLinkSelf', async () => {
      const { prisma, state } = makeWorld();

      await expect(invite(prisma, 'Coach@Example.com')).rejects.toMatchObject({
        httpStatus: 422,
        error: StudentInviteErrorCode.CANNOT_LINK_SELF,
        messageCode: StudentInviteMessageCode.CANNOT_LINK_SELF,
      });
      expect(state.studentInvites).toEqual([]);
    });

    it('should keep the invite of an address without an account out of the consent flow', async () => {
      const { prisma, state } = makeWorld({ withStudent: false });

      const result = await invite(prisma, UNKNOWN_EMAIL);

      expect(result.outcome).toBe(StudentInviteOutcome.INVITED);
      expect(invitesFor(state, UNKNOWN_EMAIL)[0].requiresConsent).toBe(false);
    });

    it('should send the download e-mail, not the "open the app" one, to an address without an account', async () => {
      const { prisma } = makeWorld({ withStudent: false });

      await invite(prisma, UNKNOWN_EMAIL);

      expect(emailSender.sendStudentInviteEmail).toHaveBeenCalledWith({ to: UNKNOWN_EMAIL, trainerName: TRAINER_NAME });
      expect(emailSender.sendStudentInviteOpenAppEmail).not.toHaveBeenCalled();
    });
  });

  describe('acceptPendingInvitesForUser', () => {
    const student = { id: STUDENT_ID, email: STORED_STUDENT_EMAIL };

    it('should leave a pending consent invite pending and link nothing', async () => {
      const { prisma, state } = makeWorld({ invites: [makeInvite()] });

      const accepted = await acceptPendingInvitesForUser(prisma, student);

      expect(accepted).toBe(0);
      expect(state.studentInvites[0]).toMatchObject({ status: StudentInviteStatus.PENDING, studentId: null, acceptedAt: null });
      expect(state.trainerStudents).toEqual([]);
    });

    it('should fire no first-student-linked milestone for a consent invite', async () => {
      const { prisma } = makeWorld({ invites: [makeInvite()] });

      await acceptPendingInvitesForUser(prisma, student);

      expect(maybeMarkFirstStudentLinked).not.toHaveBeenCalled();
    });

    it('should keep accepting automatically the invite created before the account existed', async () => {
      const automatic = makeInvite({ id: 'invite-auto', trainerId: OTHER_TRAINER_ID, requiresConsent: false });
      const { prisma, state } = makeWorld({ invites: [makeInvite(), automatic] });

      const accepted = await acceptPendingInvitesForUser(prisma, student);

      expect(accepted).toBe(1);
      expect(state.trainerStudents).toEqual([expect.objectContaining({ trainerId: OTHER_TRAINER_ID, studentId: STUDENT_ID })]);
      expect(state.studentInvites.find((row) => row.id === 'invite-auto').status).toBe(StudentInviteStatus.ACCEPTED);
      expect(state.studentInvites.find((row) => row.id === INVITE_ID).status).toBe(StudentInviteStatus.PENDING);
    });
  });

  describe('resendStudentInvite for a pending consent invite', () => {
    it.each(ACCOUNT_STATES)('should send the "open the app" e-mail to an account with %s', async (_label, studentVerified) => {
      const { prisma } = makeWorld({ studentVerified, invites: [makeInvite()] });

      await resend(prisma);

      expect(emailSender.sendStudentInviteOpenAppEmail).toHaveBeenCalledTimes(1);
      expect(emailSender.sendStudentInviteOpenAppEmail).toHaveBeenCalledWith({ to: STUDENT_EMAIL, trainerName: TRAINER_NAME });
    });

    it.each(ACCOUNT_STATES)('should send no other e-mail and issue no code for an account with %s', async (_label, studentVerified) => {
      const { prisma } = makeWorld({ studentVerified, invites: [makeInvite()] });

      await resend(prisma);

      expect(emailSender.sendExistingUserStudentInviteEmail).not.toHaveBeenCalled();
      expect(emailSender.sendStudentInviteEmail).not.toHaveBeenCalled();
      expect(issueCodeRespectingLimits).not.toHaveBeenCalled();
    });

    it('should keep the invite a pending consent invite and count the send', async () => {
      const { prisma, state } = makeWorld({ studentVerified: false, invites: [makeInvite()] });

      const result = await resend(prisma);

      expect(result).toMatchObject({ id: INVITE_ID, status: StudentInviteStatus.PENDING });
      expect(state.studentInvites[0]).toMatchObject({ status: StudentInviteStatus.PENDING, requiresConsent: true, sendCount: 2 });
      expect(state.trainerStudents).toEqual([]);
    });

    it('should reject with 502 studentInvite.emailSendFailed and not count the send when the provider refuses', async () => {
      const { prisma, state } = makeWorld({ invites: [makeInvite()] });
      emailSender.sendStudentInviteOpenAppEmail.mockResolvedValue({ error: { message: 'refused' } });

      await expect(resend(prisma)).rejects.toMatchObject({
        httpStatus: 502,
        error: StudentInviteErrorCode.EMAIL_SEND_FAILED,
        messageCode: StudentInviteMessageCode.EMAIL_SEND_FAILED,
      });
      expect(state.studentInvites[0].sendCount).toBe(1);
    });
  });

  describe('resendStudentInvite for an invite created before the account existed', () => {
    it('should no longer send the verification-code variant once the address has an unverified account', async () => {
      const { prisma } = makeWorld({ studentVerified: false, invites: [makeInvite({ requiresConsent: false })] });

      const result = await resend(prisma);

      expect(result).toMatchObject({ id: INVITE_ID, status: StudentInviteStatus.PENDING });
      expect(emailSender.sendExistingUserStudentInviteEmail).not.toHaveBeenCalled();
      expect(issueCodeRespectingLimits).not.toHaveBeenCalled();
    });

    it('should keep sending the download e-mail while the address has no account', async () => {
      const { prisma } = makeWorld({ withStudent: false, invites: [makeInvite({ requiresConsent: false })] });

      await resend(prisma);

      expect(emailSender.sendStudentInviteEmail).toHaveBeenCalledWith({ to: STUDENT_EMAIL, trainerName: TRAINER_NAME });
      expect(emailSender.sendStudentInviteOpenAppEmail).not.toHaveBeenCalled();
    });
  });
});
