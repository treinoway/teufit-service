import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
    trainer: { findFirst: vi.fn() },
    nutritionist: { findFirst: vi.fn() },
    account: { deleteMany: vi.fn() },
    refreshToken: { deleteMany: vi.fn() },
    passwordResetToken: { deleteMany: vi.fn() },
    address: { deleteMany: vi.fn() },
    socialNetwork: { deleteMany: vi.fn() },
    userHealthDetail: { deleteMany: vi.fn() },
    userPreferences: { deleteMany: vi.fn() },
    patientMetabolicProfile: { deleteMany: vi.fn() },
    workoutSession: { deleteMany: vi.fn() },
    anamnesisResponse: { deleteMany: vi.fn() },
    studentAnamnesis: { deleteMany: vi.fn() },
    studentFeedbackRequest: { deleteMany: vi.fn() },
    aiConversation: { deleteMany: vi.fn() },
    pointTransaction: { deleteMany: vi.fn() },
    pointBalance: { deleteMany: vi.fn() },
    challengeParticipant: { deleteMany: vi.fn() },
    trainerStudent: { deleteMany: vi.fn() },
    nutritionistPatient: { deleteMany: vi.fn() },
    waterLog: { deleteMany: vi.fn() },
    dietProtocol: { deleteMany: vi.fn() },
    patientInvite: { deleteMany: vi.fn() },
    studentInvite: { deleteMany: vi.fn() },
    aiInteractionLog: { updateMany: vi.fn() },
    trainerInvite: { deleteMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../src/config/s3-bucket-handler.js', () => ({
  default: { deleteFile: vi.fn() },
}));

import { prisma } from '../../src/db.js';
import s3BucketHandler from '../../src/config/s3-bucket-handler.js';
import { StudentInviteStatus } from '../../src/constants/student-invite.js';
import { deleteOwnAccount } from '../../src/services/account-deletion-service.js';
import { matchesWhere } from '../helpers/student-invite-consent-world.js';

const USER_ID = 'user-1';
const STORED_USER_EMAIL = '  User1@Example.com ';
const NORMALIZED_USER_EMAIL = 'user1@example.com';
const OTHER_EMAIL = 'someone.else@example.com';
const OTHER_STUDENT_ID = 'user-2';
const TRAINER_ID = 'trainer-1';

// Builds a stored student invite row.
function inviteRow(overrides = {}) {
  return {
    id: 'invite-1',
    trainerId: TRAINER_ID,
    email: NORMALIZED_USER_EMAIL,
    status: StudentInviteStatus.PENDING,
    studentId: null,
    requiresConsent: true,
    ...overrides,
  };
}

// Where clauses of every studentInvite.deleteMany call made so far.
function studentInviteDeleteWheres() {
  return prisma.studentInvite.deleteMany.mock.calls.map(([args]) => args?.where);
}

// True when some studentInvite.deleteMany call made so far would delete the row.
function wouldDelete(row) {
  return studentInviteDeleteWheres().some((where) => matchesWhere(row, where));
}

describe('account-deletion-service: student invites addressed to the deleted user', () => {
  beforeEach(() => {
    prisma.$transaction.mockImplementation(async (work) => work(prisma));
    prisma.user.findUnique.mockResolvedValue({ id: USER_ID, email: STORED_USER_EMAIL, avatarUrl: null, deletedAt: null });
    prisma.trainer.findFirst.mockResolvedValue(null);
    prisma.nutritionist.findFirst.mockResolvedValue(null);
    s3BucketHandler.deleteFile.mockResolvedValue(undefined);
  });

  it.each([
    ['pending', StudentInviteStatus.PENDING],
    ['accepted', StudentInviteStatus.ACCEPTED],
    ['revoked', StudentInviteStatus.REVOKED],
    ['expired', StudentInviteStatus.EXPIRED],
  ])('should delete a %s invite addressed to the normalized lowercase e-mail of the user', async (_label, status) => {
    await deleteOwnAccount(USER_ID);

    expect(wouldDelete(inviteRow({ status }))).toBe(true);
  });

  it('should match the e-mail by plain equality on the trimmed lowercase address', async () => {
    await deleteOwnAccount(USER_ID);

    const emailConditions = studentInviteDeleteWheres().flatMap((where) => [where, ...(where?.OR ?? [])].map((branch) => branch?.email));
    expect(emailConditions).toContain(NORMALIZED_USER_EMAIL);
  });

  it('should keep the invites addressed to other people', async () => {
    await deleteOwnAccount(USER_ID);

    expect(prisma.studentInvite.deleteMany).toHaveBeenCalled();
    expect(wouldDelete(inviteRow({ id: 'invite-other', email: OTHER_EMAIL, studentId: OTHER_STUDENT_ID }))).toBe(false);
    expect(wouldDelete(inviteRow({ id: 'invite-other-open', email: OTHER_EMAIL, studentId: null }))).toBe(false);
  });

  it('should delete the invites inside the deletion transaction', async () => {
    prisma.$transaction.mockResolvedValue(undefined);

    await deleteOwnAccount(USER_ID);

    expect(prisma.studentInvite.deleteMany).not.toHaveBeenCalled();
  });

  it('should delete the invites before the e-mail of the user is erased', async () => {
    await deleteOwnAccount(USER_ID);

    const [deleteOrder] = prisma.studentInvite.deleteMany.mock.invocationCallOrder;
    const [eraseOrder] = prisma.user.update.mock.invocationCallOrder;
    expect(deleteOrder).toBeLessThan(eraseOrder);
  });

  it('should delete no invite of another address when the user has no e-mail', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: USER_ID, email: null, avatarUrl: null, deletedAt: null });

    await deleteOwnAccount(USER_ID);

    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    expect(wouldDelete(inviteRow({ id: 'invite-other-open', email: OTHER_EMAIL, studentId: null }))).toBe(false);
  });
});
