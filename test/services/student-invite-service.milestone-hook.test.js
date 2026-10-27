import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  maybeMarkFirstStudentInvited: vi.fn(),
}));
vi.mock('../../src/services/briefing-service.js', () => ({
  markBriefingDirty: vi.fn(),
}));

import {
  issueCodeRespectingLimits,
  markVerificationSendFailed,
  confirmVerificationCodeDelivered,
} from '../../src/services/email-verification-service.js';
import { findUserIdByEmailCaseInsensitive } from '../../src/helpers/email-lookup.js';
import { assertStudentCap } from '../../src/services/platform-plan-service.js';
import { maybeMarkFirstStudentInvited } from '../../src/services/trainer-onboarding-service.js';
import { StudentInviteOutcome, StudentInviteStatus } from '../../src/constants/student-invite.js';
import { inviteStudent } from '../../src/services/student-invite-service.js';

const TRAINER_ID = 'trainer-1';
const TRAINER_USER_ID = 'trainer-user-1';
const STUDENT_EMAIL = 'student@example.com';
const INVITE_ID = 'invite-1';

// Builds a prisma mock whose interactive transaction runs the callback on itself.
function makePrisma() {
  const prisma = {
    user: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    account: { findFirst: vi.fn() },
    studentInvite: { create: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
  };
  prisma.$transaction = vi.fn(async (callback) => callback(prisma));
  return prisma;
}

describe('inviteStudent first-student-invited milestone hook', () => {
  let prisma;
  let emailSender;

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    prisma = makePrisma();
    emailSender = {
      sendStudentInviteEmail: vi.fn().mockResolvedValue(undefined),
      sendExistingUserStudentInviteEmail: vi.fn().mockResolvedValue(undefined),
    };
    issueCodeRespectingLimits.mockResolvedValue({ code: '123456', tokenId: 't1', userId: 'u1', createdAt: new Date() });
    markVerificationSendFailed.mockResolvedValue(undefined);
    confirmVerificationCodeDelivered.mockResolvedValue(undefined);
    findUserIdByEmailCaseInsensitive.mockResolvedValue(null);
    assertStudentCap.mockResolvedValue(undefined);
    prisma.user.findUnique.mockResolvedValue({ firstName: 'Ana', lastName: 'Coach', email: STUDENT_EMAIL, deletedAt: null });
    prisma.studentInvite.findMany.mockResolvedValue([]);
    prisma.studentInvite.count.mockResolvedValue(0);
    prisma.studentInvite.create.mockImplementation(async ({ data }) => ({
      id: INVITE_ID,
      status: StudentInviteStatus.PENDING,
      sendCount: 0,
      lastSentAt: new Date(),
      acceptedAt: null,
      revokedAt: null,
      ...data,
    }));
    maybeMarkFirstStudentInvited.mockResolvedValue(undefined);
  });

  const invite = () =>
    inviteStudent(prisma, { trainerId: TRAINER_ID, trainerUserId: TRAINER_USER_ID, email: STUDENT_EMAIL }, { emailSender });

  it('should call maybeMarkFirstStudentInvited with the trainerId and the prisma client passed as tx', async () => {
    await invite();

    expect(maybeMarkFirstStudentInvited).toHaveBeenCalledTimes(1);
    expect(maybeMarkFirstStudentInvited).toHaveBeenCalledWith({ trainerId: TRAINER_ID, tx: prisma });
  });

  it('should still return the invited outcome when the milestone hook rejects', async () => {
    maybeMarkFirstStudentInvited.mockRejectedValue(new Error('milestone failed'));

    const result = await invite();

    expect(result.outcome).toBe(StudentInviteOutcome.INVITED);
    expect(result.invite.id).toBe(INVITE_ID);
  });

  it('should still deliver the invite email when the milestone hook rejects', async () => {
    maybeMarkFirstStudentInvited.mockRejectedValue(new Error('milestone failed'));

    await invite();

    expect(emailSender.sendStudentInviteEmail).toHaveBeenCalledTimes(1);
  });

  it('should log the milestone failure as non-critical', async () => {
    maybeMarkFirstStudentInvited.mockRejectedValue(new Error('milestone failed'));

    await invite();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('milestone failed'));
  });
});
