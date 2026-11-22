import crypto from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config/email-handler.js', () => ({
  default: { sendEmailVerificationEmail: vi.fn() },
}));
vi.mock('../../src/services/student-invite-service.js', () => ({
  acceptPendingInvitesForUser: vi.fn(),
}));

import { acceptPendingInvitesForUser } from '../../src/services/student-invite-service.js';
import { verifyEmailCode } from '../../src/services/email-verification-service.js';
import { EMAIL_PROVIDER, EMAIL_VERIFICATION_TTL_MS } from '../../src/constants/email-verification.js';

const USER_ID = 'user-1';
const EMAIL = 'new.trainer@example.com';
const CODE = '482913';
const TOKEN_ID = 'token-1';

// Hashes a code the way stored verification codes are hashed.
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// Prisma double for a direct-signup user with an unverified email Account and one active code.
function makePrisma() {
  const prisma = {
    user: {
      findUnique: vi.fn().mockResolvedValue({ id: USER_ID, email: EMAIL, deletedAt: null }),
      update: vi.fn().mockResolvedValue({ id: USER_ID }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    account: {
      findFirst: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    emailVerificationToken: {
      findFirst: vi.fn().mockResolvedValue({
        id: TOKEN_ID,
        userId: USER_ID,
        tokenHash: sha256(CODE),
        used: false,
        attempts: 0,
        sendFailedAt: null,
        expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS),
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    refreshToken: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    passwordResetToken: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
  };
  prisma.$transaction = vi.fn(async (work) => (typeof work === 'function' ? work(prisma) : Promise.all(work)));
  return prisma;
}

// Collects the data of every write made to the users table.
function userWrites(prisma) {
  return [...prisma.user.update.mock.calls, ...prisma.user.updateMany.mock.calls].map(([args]) => args.data);
}

describe('verifyEmailCode keeps the credentials of the session that verifies (pre-hijack guard, case c)', () => {
  let prisma;

  beforeEach(() => {
    prisma = makePrisma();
    acceptPendingInvitesForUser.mockResolvedValue(0);
  });

  it('should verify the email Account with the correct code', async () => {
    await expect(verifyEmailCode(prisma, { userId: USER_ID, code: CODE })).resolves.toMatchObject({ verified: true });

    expect(prisma.account.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: USER_ID, provider: EMAIL_PROVIDER }) }),
    );
  });

  it('should not change the password set at signup', async () => {
    await verifyEmailCode(prisma, { userId: USER_ID, code: CODE });

    for (const data of userWrites(prisma)) expect(data).not.toHaveProperty('passwordHash');
  });

  it('should not revoke or delete any refresh token', async () => {
    await verifyEmailCode(prisma, { userId: USER_ID, code: CODE });

    expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
    expect(prisma.refreshToken.deleteMany).not.toHaveBeenCalled();
  });
});
