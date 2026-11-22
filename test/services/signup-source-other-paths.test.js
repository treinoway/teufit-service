import crypto from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    account: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    user: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    refreshToken: { updateMany: vi.fn() },
    passwordResetToken: { updateMany: vi.fn() },
    emailVerificationToken: { updateMany: vi.fn() },
    trainerInvite: { findUnique: vi.fn(), updateMany: vi.fn() },
    pendingSignup: { deleteMany: vi.fn() },
    trainer: { findUnique: vi.fn() },
    platformSubscription: { create: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  },
}));
vi.mock('../../src/config/email-handler.js', () => ({
  default: { sendEmailVerificationEmail: vi.fn(), sendExistingAccountSignupEmail: vi.fn(), sendTrainerInviteEmail: vi.fn() },
}));
vi.mock('../../src/services/student-invite-service.js', () => ({
  acceptPendingInvitesForUser: vi.fn(),
}));
vi.mock('../../src/services/user-service.js', () => ({ setActiveProfileToTrainer: vi.fn() }));

import { prisma } from '../../src/db.js';
import { acceptPendingInvitesForUser } from '../../src/services/student-invite-service.js';
import { setActiveProfileToTrainer } from '../../src/services/user-service.js';
import { EMAIL_VERIFICATION_TTL_MS } from '../../src/constants/email-verification.js';
import { InviteStatus } from '../../src/constants/trainer-invite.js';
import { Roles } from '../../src/constants/roles.js';
import { verifySignupCode } from '../../src/services/signup-verification-service.js';
import { signupWithInvite } from '../../src/services/trainer-invite-service.js';
import { findOrCreateUserFromOAuth } from '../../src/helpers/auth.js';

const SIGNUP_SOURCE_FIELD = 'signupSource';
const EMAIL = 'new.person@example.com';
const PASSWORD = 'correct horse battery';
const CORRECT_CODE = '123456';
const INVITE_CODE = 'TF-ABCD-EFGH-12';
const NEW_USER_ID = 'new-user-1';
const HOUR_MS = 60 * 60 * 1000;
const OAUTH_PROVIDERS = ['google', 'apple', 'firebase'];

// Hex SHA-256, as the signup code is stored.
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// Prisma double for POST /auth/signup/verify with one active code for the pending signup.
function makeVerifyPrisma() {
  const activeCode = {
    id: 'code-1',
    pendingSignupId: 'pending-1',
    tokenHash: sha256(CORRECT_CODE),
    used: false,
    attempts: 0,
    expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS),
    createdAt: new Date(),
    sendFailedAt: null,
  };
  const double = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    user: { findUnique: vi.fn(), create: vi.fn(async ({ data }) => ({ id: NEW_USER_ID, ...data })), update: vi.fn(), updateMany: vi.fn() },
    account: { create: vi.fn().mockResolvedValue({ id: 'account-1' }) },
    pendingSignup: {
      findUnique: vi.fn().mockResolvedValue({ id: 'pending-1' }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    pendingSignupCode: {
      findMany: vi.fn().mockResolvedValue([activeCode]),
      findFirst: vi.fn().mockResolvedValue(activeCode),
      findUnique: vi.fn().mockResolvedValue({ used: false }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  double.$transaction = vi.fn(async (callback) => callback(double));
  return double;
}

// Data objects of every user create and update issued through the given client.
function userWrites(client) {
  return [client.user.create, client.user.update, client.user.updateMany].flatMap((method) =>
    method.mock.calls.map(([args]) => args.data),
  );
}

// Asserts that the path created exactly one user and never wrote signupSource.
function expectUserCreatedWithoutSignupSource(client) {
  expect(client.user.create).toHaveBeenCalledTimes(1);
  for (const data of userWrites(client)) expect(data).not.toHaveProperty(SIGNUP_SOURCE_FIELD);
}

describe('signupSource is written by the direct signup only', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    acceptPendingInvitesForUser.mockResolvedValue(0);
    prisma.$queryRaw.mockResolvedValue([]);
    prisma.account.findUnique.mockResolvedValue(null);
    prisma.account.findFirst.mockResolvedValue(null);
    prisma.account.create.mockResolvedValue({});
    prisma.account.update.mockResolvedValue({});
    prisma.user.create.mockImplementation(async ({ data }) => ({ id: NEW_USER_ID, deletedAt: null, ...data }));
    prisma.user.update.mockImplementation(async ({ data }) => ({ id: NEW_USER_ID, deletedAt: null, ...data }));
    prisma.$transaction.mockImplementation(async (work) => (typeof work === 'function' ? work(prisma) : Promise.all(work)));
  });

  it('should not write signupSource when POST /auth/signup/verify creates the user', async () => {
    const client = makeVerifyPrisma();

    await verifySignupCode(client, { email: EMAIL, code: CORRECT_CODE, password: PASSWORD });

    expectUserCreatedWithoutSignupSource(client);
  });

  it.each(OAUTH_PROVIDERS)('should not write signupSource when a first %s sign-in creates the user', async (provider) => {
    await findOrCreateUserFromOAuth({
      provider,
      providerId: `${provider}-subject-1`,
      email: EMAIL,
      emailVerified: true,
      name: 'New Person',
      avatar: null,
      accessToken: 'access',
      refreshToken: 'refresh',
    });

    expectUserCreatedWithoutSignupSource(prisma);
  });

  it('should not write signupSource when POST /auth/signup/invite creates the trainer', async () => {
    prisma.trainerInvite.findUnique.mockResolvedValue({
      id: 'invite-1',
      email: EMAIL,
      codeHash: 'hash',
      status: InviteStatus.PENDING,
      userId: null,
      expiresAt: new Date(Date.now() + HOUR_MS),
    });
    prisma.trainerInvite.updateMany.mockResolvedValue({ count: 1 });
    prisma.pendingSignup.deleteMany.mockResolvedValue({ count: 0 });
    prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
    prisma.platformSubscription.create.mockResolvedValue({});
    setActiveProfileToTrainer.mockResolvedValue({ userId: NEW_USER_ID, activeProfile: Roles.TRAINER });

    await signupWithInvite({ code: INVITE_CODE, password: PASSWORD });

    expectUserCreatedWithoutSignupSource(prisma);
  });
});
