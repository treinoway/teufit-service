import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    trainerInvite: { findUnique: vi.fn(), updateMany: vi.fn() },
    user: { create: vi.fn() },
    account: { create: vi.fn() },
    pendingSignup: { deleteMany: vi.fn() },
    trainer: { findUnique: vi.fn(), findFirst: vi.fn() },
    platformSubscription: { findUnique: vi.fn(), create: vi.fn(), upsert: vi.fn(), update: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  },
}));

vi.mock('../../src/services/user-service.js', () => ({ setActiveProfileToTrainer: vi.fn() }));
vi.mock('../../src/services/email-verification-service.js', () => ({ markEmailVerifiedFromInboxProof: vi.fn() }));
vi.mock('../../src/services/platform-plan-service.js', () => ({
  reactivateStudentsUpToCap: vi.fn().mockResolvedValue(undefined),
  getTrainerPlan: vi.fn(),
}));
vi.mock('../../src/config/email-handler.js', () => ({
  default: { sendTrainerInviteEmail: vi.fn(), sendEmailVerificationEmail: vi.fn() },
}));
vi.mock('../../src/helpers/password.js', () => ({ hashPassword: vi.fn() }));

import { prisma } from '../../src/db.js';
import { hashPassword } from '../../src/helpers/password.js';
import { setActiveProfileToTrainer } from '../../src/services/user-service.js';
import { markEmailVerifiedFromInboxProof } from '../../src/services/email-verification-service.js';
import { reactivateStudentsUpToCap } from '../../src/services/platform-plan-service.js';
import { Roles } from '../../src/constants/roles.js';
import { InviteStatus } from '../../src/constants/trainer-invite.js';
import { PLATFORM_SUBSCRIPTION_STATUSES } from '../../src/constants/platform-plan.js';
import { signupWithInvite, redeemInvite } from '../../src/services/trainer-invite-service.js';

const CODE = 'TF-ABCD-EFGH-12';
const PASSWORD = 'StrongPassw0rd!';
const INVITE_ID = 'invite-1';
const USER_ID = 'user-1';
const TRAINER_ID = 'trainer-1';
const INVITE_EMAIL = 'invitee@example.com';
const ASAAS_SUBSCRIPTION_ID = 'sub_sandbox_001';
const BETA_TIER = 'BETA';
const HOUR_MS = 60 * 60 * 1000;

// Builds a pending invite row with overridable fields.
function pendingInvite(overrides = {}) {
  return {
    id: INVITE_ID,
    email: INVITE_EMAIL,
    codeHash: 'hash',
    status: InviteStatus.PENDING,
    userId: null,
    expiresAt: new Date(Date.now() + HOUR_MS),
    ...overrides,
  };
}

// Collects every BETA grant payload written through create or upsert on platformSubscription.
function betaGrants() {
  const fromCreate = prisma.platformSubscription.create.mock.calls.map(([args]) => args.data);
  const fromUpsert = prisma.platformSubscription.upsert.mock.calls.map(([args]) => args.create);
  return [...fromCreate, ...fromUpsert].filter((data) => data?.tier === BETA_TIER);
}

// Lists every tier value written to platformSubscription by any write method.
function writtenTiers() {
  const calls = [
    ...prisma.platformSubscription.create.mock.calls.map(([args]) => args.data),
    ...prisma.platformSubscription.upsert.mock.calls.flatMap(([args]) => [args.create, args.update]),
    ...prisma.platformSubscription.update.mock.calls.map(([args]) => args.data),
  ];
  return calls.map((data) => data?.tier).filter(Boolean);
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.$transaction.mockImplementation(async (callback) => callback(prisma));
  prisma.trainerInvite.findUnique.mockResolvedValue(pendingInvite());
  prisma.trainerInvite.updateMany.mockResolvedValue({ count: 1 });
  prisma.$queryRaw.mockResolvedValue([]);
  prisma.user.create.mockResolvedValue({ id: USER_ID, email: INVITE_EMAIL, roles: [Roles.TRAINER] });
  prisma.account.create.mockResolvedValue({});
  prisma.pendingSignup.deleteMany.mockResolvedValue({ count: 0 });
  prisma.trainer.findUnique.mockResolvedValue({ id: TRAINER_ID, userId: USER_ID });
  prisma.trainer.findFirst.mockResolvedValue({ id: TRAINER_ID, userId: USER_ID });
  prisma.platformSubscription.findUnique.mockResolvedValue(null);
  prisma.platformSubscription.create.mockResolvedValue({});
  prisma.platformSubscription.upsert.mockResolvedValue({});
  prisma.platformSubscription.update.mockResolvedValue({});
  setActiveProfileToTrainer.mockResolvedValue({ userId: USER_ID, activeProfile: 'trainer' });
  markEmailVerifiedFromInboxProof.mockResolvedValue(true);
  hashPassword.mockReturnValue('scrypt$hashed');
});

describe('signupWithInvite grants BETA', () => {
  it('should not write a second BETA subscription itself', async () => {
    await signupWithInvite({ code: CODE, password: PASSWORD });

    expect(setActiveProfileToTrainer).toHaveBeenCalledTimes(1);
    expect(betaGrants()).toEqual([]);
  });

  it('should grant the trainer profile (and its BETA subscription) inside the signup transaction', async () => {
    const tx = {
      ...prisma,
      platformSubscription: { create: vi.fn().mockResolvedValue({}), upsert: vi.fn().mockResolvedValue({}) },
    };
    prisma.$transaction.mockImplementation(async (callback) => callback(tx));

    await signupWithInvite({ code: CODE, password: PASSWORD });

    expect(setActiveProfileToTrainer).toHaveBeenCalledWith(USER_ID, expect.objectContaining({ tx }));
    expect(tx.platformSubscription.create).not.toHaveBeenCalled();
    expect(tx.platformSubscription.upsert).not.toHaveBeenCalled();
    expect(prisma.platformSubscription.create).not.toHaveBeenCalled();
    expect(prisma.platformSubscription.upsert).not.toHaveBeenCalled();
  });

  it('should not create a BETA subscription when the invite claim is lost', async () => {
    prisma.trainerInvite.updateMany.mockResolvedValue({ count: 0 });
    prisma.trainerInvite.findUnique
      .mockResolvedValueOnce(pendingInvite())
      .mockResolvedValue(pendingInvite({ status: InviteStatus.ACCEPTED, userId: 'someone' }));

    await expect(signupWithInvite({ code: CODE, password: PASSWORD })).rejects.toBeDefined();

    expect(betaGrants()).toHaveLength(0);
  });
});

describe('redeemInvite grants BETA to an existing user', () => {
  const user = { id: USER_ID, email: INVITE_EMAIL };

  it('should grant BETA ACTIVE when the user has no subscription row', async () => {
    prisma.platformSubscription.findUnique.mockResolvedValue(null);

    await redeemInvite({ user, code: CODE });

    expect(prisma.platformSubscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { trainerId: TRAINER_ID },
        create: expect.objectContaining({ trainerId: TRAINER_ID, tier: BETA_TIER, status: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE }),
        update: expect.objectContaining({ tier: BETA_TIER, status: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE }),
      })
    );
  });

  it('should grant BETA when the user has a FREE row without an Asaas subscription', async () => {
    prisma.platformSubscription.findUnique.mockResolvedValue({
      trainerId: TRAINER_ID,
      tier: 'FREE',
      asaasSubscriptionId: null,
    });

    await redeemInvite({ user, code: CODE });

    expect(writtenTiers()).toContain(BETA_TIER);
  });

  it('should reactivate blocked students after granting BETA', async () => {
    await redeemInvite({ user, code: CODE });

    expect(reactivateStudentsUpToCap).toHaveBeenCalledWith(prisma, TRAINER_ID);
  });

  it('should leave the tier untouched when the user already pays through Asaas', async () => {
    prisma.platformSubscription.findUnique.mockResolvedValue({
      trainerId: TRAINER_ID,
      tier: 'PRO',
      status: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE,
      asaasSubscriptionId: ASAAS_SUBSCRIPTION_ID,
    });

    await redeemInvite({ user, code: CODE });

    expect(writtenTiers()).not.toContain(BETA_TIER);
    expect(prisma.platformSubscription.upsert).not.toHaveBeenCalled();
    expect(prisma.platformSubscription.update).not.toHaveBeenCalled();
  });

  it('should not grant BETA when the invite email does not match the user', async () => {
    prisma.trainerInvite.findUnique.mockResolvedValue(pendingInvite({ email: 'other@example.com' }));

    await expect(redeemInvite({ user, code: CODE })).rejects.toBeDefined();

    expect(writtenTiers()).toHaveLength(0);
  });
});
