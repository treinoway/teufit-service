import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    trainerInvite: { findUnique: vi.fn(), updateMany: vi.fn() },
    trainer: { findUnique: vi.fn() },
    platformSubscription: { findUnique: vi.fn(), upsert: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  },
}));
vi.mock('../../src/services/user-service.js', () => ({ setActiveProfileToTrainer: vi.fn() }));
vi.mock('../../src/services/email-verification-service.js', () => ({ markEmailVerifiedFromInboxProof: vi.fn() }));
vi.mock('../../src/services/platform-plan-service.js', () => ({
  reactivateStudentsUpToCap: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/config/email-handler.js', () => ({
  default: { sendTrainerInviteEmail: vi.fn(), sendEmailVerificationEmail: vi.fn() },
}));

import { prisma } from '../../src/db.js';
import { setActiveProfileToTrainer } from '../../src/services/user-service.js';
import { reactivateStudentsUpToCap } from '../../src/services/platform-plan-service.js';
import { InviteStatus } from '../../src/constants/trainer-invite.js';
import { redeemInvite } from '../../src/services/trainer-invite-service.js';

const CODE = 'TF-ABCD-EFGH-12';
const USER_ID = 'user-1';
const TRAINER_ID = 'trainer-1';
const user = { id: USER_ID, email: 'invitee@example.com' };

// Builds an invite already accepted by the redeeming user.
function acceptedInvite() {
  return { id: 'invite-1', email: user.email, status: InviteStatus.ACCEPTED, userId: USER_ID, expiresAt: new Date(Date.now() + 3600000) };
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.$transaction.mockImplementation(async (callback) => callback(prisma));
  prisma.trainerInvite.findUnique.mockResolvedValue(acceptedInvite());
  prisma.$queryRaw.mockResolvedValue([]);
  prisma.trainer.findUnique.mockResolvedValue({ id: TRAINER_ID });
  prisma.platformSubscription.findUnique.mockResolvedValue(null);
  prisma.platformSubscription.upsert.mockResolvedValue({});
  setActiveProfileToTrainer.mockResolvedValue({ userId: USER_ID });
});

describe('redeemInvite on the idempotent ACCEPTED branch', () => {
  it('should grant BETA so a failed first grant is recoverable', async () => {
    await redeemInvite({ user, code: CODE });

    expect(prisma.platformSubscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ trainerId: TRAINER_ID, tier: 'BETA' }) })
    );
    expect(reactivateStudentsUpToCap).toHaveBeenCalledWith(prisma, TRAINER_ID);
  });

  it('should leave a paying trainer untouched and not reactivate students', async () => {
    prisma.platformSubscription.findUnique.mockResolvedValue({ tier: 'PRO', asaasSubscriptionId: 'sub_1' });

    await redeemInvite({ user, code: CODE });

    expect(prisma.platformSubscription.upsert).not.toHaveBeenCalled();
    expect(reactivateStudentsUpToCap).not.toHaveBeenCalled();
  });
});

describe('BETA grant concurrency safety', () => {
  it('should read and write the subscription inside one transaction holding a row lock', async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      platformSubscription: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn().mockResolvedValue({}) },
    };
    prisma.$transaction.mockImplementation(async (callback) => callback(tx));

    await redeemInvite({ user, code: CODE });

    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(tx.platformSubscription.findUnique).toHaveBeenCalledOnce();
    expect(tx.platformSubscription.upsert).toHaveBeenCalledOnce();
    expect(prisma.platformSubscription.upsert).not.toHaveBeenCalled();
  });

  it('should throw a 404 AppError instead of a TypeError when the user has no trainer profile', async () => {
    prisma.trainer.findUnique.mockResolvedValue(null);

    await expect(redeemInvite({ user, code: CODE })).rejects.toMatchObject({
      httpStatus: 404,
      error: 'TRAINER_NOT_FOUND',
    });
  });
});
