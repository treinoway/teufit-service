import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    account: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    refreshToken: { updateMany: vi.fn() },
    passwordResetToken: { updateMany: vi.fn() },
    emailVerificationToken: { updateMany: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  },
}));

vi.mock('../../src/services/student-invite-service.js', () => ({
  acceptPendingInvitesForUser: vi.fn(),
}));

import { prisma } from '../../src/db.js';
import { acceptPendingInvitesForUser } from '../../src/services/student-invite-service.js';
import { OAuthErrorCode, OAuthMessageCode, SecurityEvent } from '../../src/constants/oauth-security.js';
import { EMAIL_PROVIDER } from '../../src/constants/email-verification.js';
import { findOrCreateUserFromOAuth } from '../../src/helpers/auth.js';

const PROVIDER = 'google';
const PROVIDER_ID = 'google-sub-1';
const EMAIL = 'Student@Example.com';
const NORMALIZED_EMAIL = 'student@example.com';
const UNVERIFIED_VALUES = [
  ['false', false],
  ['omitted', undefined],
  ['a truthy non-boolean string', 'true'],
];

function providerData(overrides = {}) {
  return {
    provider: PROVIDER,
    providerId: PROVIDER_ID,
    email: EMAIL,
    name: 'Student Person',
    avatar: null,
    accessToken: 'at',
    refreshToken: 'rt',
    ...overrides,
  };
}

describe('findOrCreateUserFromOAuth emailVerified behavior', () => {
  beforeEach(() => {
    prisma.account.findUnique.mockResolvedValue(null);
    prisma.account.create.mockResolvedValue({});
    prisma.account.update.mockResolvedValue({});
    prisma.$queryRaw.mockResolvedValue([]);
    prisma.user.create.mockResolvedValue({ id: 'new-user', email: NORMALIZED_EMAIL, deletedAt: null });
    prisma.account.findFirst.mockResolvedValue(null);
    prisma.$transaction.mockImplementation(async (ops) => Promise.all(ops));
    acceptPendingInvitesForUser.mockResolvedValue(0);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  describe('new user', () => {
    it('should set Account.verifiedAt and accept pending invites when the provider verified the email', async () => {
      const user = await findOrCreateUserFromOAuth(providerData({ emailVerified: true }));

      expect(prisma.account.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ verifiedAt: expect.any(Date) }),
      });
      expect(acceptPendingInvitesForUser).toHaveBeenCalledTimes(1);
      expect(acceptPendingInvitesForUser).toHaveBeenCalledWith(prisma, user);
    });

    it('should create the user when the provider verified the email', async () => {
      await findOrCreateUserFromOAuth(providerData({ emailVerified: true }));

      expect(prisma.user.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('unverified email (rejected before any lookup)', () => {
    it.each(UNVERIFIED_VALUES)(
      'should reject a new email with 403 and perform no lookups or writes when emailVerified is %s',
      async (_label, emailVerified) => {
        await expect(findOrCreateUserFromOAuth(providerData({ emailVerified }))).rejects.toMatchObject({
          httpStatus: 403,
          error: OAuthErrorCode.EMAIL_NOT_VERIFIED,
          messageCode: OAuthMessageCode.EMAIL_NOT_VERIFIED,
        });

        expect(prisma.account.findUnique).not.toHaveBeenCalled();
        expect(prisma.$queryRaw).not.toHaveBeenCalled();
        expect(prisma.user.create).not.toHaveBeenCalled();
        expect(prisma.account.create).not.toHaveBeenCalled();
        expect(acceptPendingInvitesForUser).not.toHaveBeenCalled();
      },
    );

    it('should produce an identical error for a new email and an existing email', async () => {
      const capture = async () => {
        try {
          await findOrCreateUserFromOAuth(providerData({ emailVerified: false }));
        } catch (e) {
          return e;
        }
        return null;
      };
      const forNewEmail = await capture();
      prisma.$queryRaw.mockResolvedValue([{ id: 'existing-user' }]);
      prisma.user.findUnique.mockResolvedValue({ id: 'existing-user', email: NORMALIZED_EMAIL, deletedAt: null });
      const forExistingEmail = await capture();

      expect(forNewEmail).not.toBeNull();
      expect({
        httpStatus: forExistingEmail.httpStatus,
        error: forExistingEmail.error,
        messageCode: forExistingEmail.messageCode,
        message: forExistingEmail.message,
        details: forExistingEmail.details,
      }).toEqual({
        httpStatus: forNewEmail.httpStatus,
        error: forNewEmail.error,
        messageCode: forNewEmail.messageCode,
        message: forNewEmail.message,
        details: forNewEmail.details,
      });
    });

    it.each(UNVERIFIED_VALUES)(
      'should reject an already-linked account with 403 and not update it when emailVerified is %s',
      async (_label, emailVerified) => {
        prisma.account.findUnique.mockResolvedValue({
          id: 'acc-1',
          verifiedAt: null,
          user: { id: 'u1', deletedAt: null },
        });

        await expect(findOrCreateUserFromOAuth(providerData({ emailVerified }))).rejects.toMatchObject({
          httpStatus: 403,
          error: OAuthErrorCode.EMAIL_NOT_VERIFIED,
        });

        expect(prisma.account.update).not.toHaveBeenCalled();
      },
    );

    it('should log a [security] warning with only the provider and no secrets or userId', async () => {
      await expect(findOrCreateUserFromOAuth(providerData({ emailVerified: false }))).rejects.toBeDefined();

      expect(console.warn).toHaveBeenCalledWith('[security]', {
        event: SecurityEvent.UNVERIFIED_EMAIL_REJECTED,
        provider: PROVIDER,
      });
      expect(JSON.stringify(console.warn.mock.calls)).not.toMatch(/userId|"at"|"rt"|Student@Example/);
    });

    it('should reject an existing unverified-email user without touching their credential', async () => {
      prisma.$queryRaw.mockResolvedValue([{ id: 'existing-user' }]);
      prisma.user.findUnique.mockResolvedValue({
        id: 'existing-user',
        email: NORMALIZED_EMAIL,
        deletedAt: null,
        passwordHash: 'attacker-hash',
      });

      await expect(findOrCreateUserFromOAuth(providerData({ emailVerified: false }))).rejects.toMatchObject({ httpStatus: 403 });

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.account.create).not.toHaveBeenCalled();
    });
  });

  describe('token without an email claim (Apple returning login)', () => {
    it('should authenticate an already-linked account', async () => {
      prisma.account.findUnique.mockResolvedValue({
        id: 'acc-1',
        verifiedAt: new Date('2026-01-01T00:00:00Z'),
        user: { id: 'u1', deletedAt: null },
      });

      const user = await findOrCreateUserFromOAuth(providerData({ email: undefined }));

      expect(user).toEqual({ id: 'u1', deletedAt: null });
      expect(prisma.account.update).toHaveBeenCalledTimes(1);
    });

    it('should reject with the same 403 when no account is linked', async () => {
      await expect(findOrCreateUserFromOAuth(providerData({ email: undefined }))).rejects.toMatchObject({
        httpStatus: 403,
        error: OAuthErrorCode.EMAIL_NOT_VERIFIED,
        messageCode: OAuthMessageCode.EMAIL_NOT_VERIFIED,
      });

      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(prisma.account.create).not.toHaveBeenCalled();
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });

  describe('existing user without an account for this provider', () => {
    beforeEach(() => {
      prisma.$queryRaw.mockResolvedValue([{ id: 'existing-user' }]);
      prisma.user.findUnique.mockResolvedValue({ id: 'existing-user', email: NORMALIZED_EMAIL, deletedAt: null });
    });

    it('should mark the new account verified and accept pending invites (unverified email user now proven)', async () => {
      const user = await findOrCreateUserFromOAuth(providerData({ emailVerified: true }));

      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(prisma.account.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ userId: 'existing-user', verifiedAt: expect.any(Date) }),
      });
      expect(acceptPendingInvitesForUser).toHaveBeenCalledTimes(1);
      expect(acceptPendingInvitesForUser).toHaveBeenCalledWith(prisma, user);
    });

    describe('verified provider attaching to a user with a password credential', () => {
      const existingWithPassword = {
        id: 'existing-user',
        email: NORMALIZED_EMAIL,
        deletedAt: null,
        passwordHash: 'attacker-hash',
      };

      beforeEach(() => {
        prisma.user.findUnique.mockResolvedValue(existingWithPassword);
      });

      it('should neutralize the unverified password credential in one transaction', async () => {
        prisma.account.findFirst.mockResolvedValue({ id: 'acc-email-unverified' });

        await findOrCreateUserFromOAuth(providerData({ emailVerified: true }));

        expect(prisma.account.findFirst).toHaveBeenCalledWith({
          where: { userId: 'existing-user', provider: EMAIL_PROVIDER, verifiedAt: null },
          select: { id: true },
        });
        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'existing-user' }, data: { passwordHash: null } });
        expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
          where: { userId: 'existing-user', revoked: false },
          data: { revoked: true, revokedAt: expect.any(Date) },
        });
        expect(prisma.passwordResetToken.updateMany).toHaveBeenCalledWith({
          where: { userId: 'existing-user', used: false },
          data: { used: true },
        });
        expect(prisma.emailVerificationToken.updateMany).toHaveBeenCalledWith({
          where: { userId: 'existing-user', used: false },
          data: { used: true },
        });
      });

      it('should keep the unverified email Account row (never delete it)', async () => {
        prisma.account.findFirst.mockResolvedValue({ id: 'acc-email-unverified' });
        prisma.account.delete = vi.fn();
        prisma.account.deleteMany = vi.fn();

        await findOrCreateUserFromOAuth(providerData({ emailVerified: true }));

        expect(prisma.account.delete).not.toHaveBeenCalled();
        expect(prisma.account.deleteMany).not.toHaveBeenCalled();
      });

      it('should attach the verified provider account and accept pending invites after neutralizing', async () => {
        prisma.account.findFirst.mockResolvedValue({ id: 'acc-email-unverified' });

        const user = await findOrCreateUserFromOAuth(providerData({ emailVerified: true }));

        expect(prisma.account.create).toHaveBeenCalledWith({
          data: expect.objectContaining({ userId: 'existing-user', provider: PROVIDER, verifiedAt: expect.any(Date) }),
        });
        expect(acceptPendingInvitesForUser).toHaveBeenCalledWith(prisma, user);
      });

      it('should log a [security] event without secrets when the credential is neutralized', async () => {
        prisma.account.findFirst.mockResolvedValue({ id: 'acc-email-unverified' });

        await findOrCreateUserFromOAuth(providerData({ emailVerified: true }));

        expect(console.warn).toHaveBeenCalledWith('[security]', expect.objectContaining({ userId: 'existing-user', provider: PROVIDER }));
        expect(JSON.stringify(console.warn.mock.calls)).not.toMatch(/attacker-hash|"at"|"rt"/);
      });

      it('should NOT neutralize when the password belongs to a verified email account', async () => {
        prisma.account.findFirst.mockResolvedValue(null);

        await findOrCreateUserFromOAuth(providerData({ emailVerified: true }));

        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(prisma.user.update).not.toHaveBeenCalled();
        expect(prisma.account.create).toHaveBeenCalledTimes(1);
      });

      it('should not neutralize when the user has no password hash', async () => {
        prisma.user.findUnique.mockResolvedValue({ ...existingWithPassword, passwordHash: null });
        prisma.account.findFirst.mockResolvedValue({ id: 'acc-email-unverified' });

        await findOrCreateUserFromOAuth(providerData({ emailVerified: true }));

        expect(prisma.account.findFirst).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it('should not attach the OAuth account when the neutralizing transaction fails', async () => {
        prisma.account.findFirst.mockResolvedValue({ id: 'acc-email-unverified' });
        prisma.$transaction.mockRejectedValue(new Error('db down'));

        await expect(findOrCreateUserFromOAuth(providerData({ emailVerified: true }))).rejects.toThrow('db down');
        expect(prisma.account.create).not.toHaveBeenCalled();
      });
    });
  });

  describe('existing account', () => {
    it('should set verifiedAt on login when the account was unverified and provider now verifies', async () => {
      prisma.account.findUnique.mockResolvedValue({
        id: 'acc-1',
        verifiedAt: null,
        user: { id: 'u1', deletedAt: null },
      });

      await findOrCreateUserFromOAuth(providerData({ emailVerified: true }));

      expect(prisma.account.update).toHaveBeenCalledWith({
        where: { id: 'acc-1' },
        data: expect.objectContaining({ verifiedAt: expect.any(Date) }),
      });
      expect(acceptPendingInvitesForUser).toHaveBeenCalledTimes(1);
      expect(acceptPendingInvitesForUser).toHaveBeenCalledWith(prisma, { id: 'u1', deletedAt: null });
    });

    it('should not overwrite an existing verifiedAt', async () => {
      prisma.account.findUnique.mockResolvedValue({
        id: 'acc-1',
        verifiedAt: new Date('2026-01-01T00:00:00Z'),
        user: { id: 'u1', deletedAt: null },
      });

      await findOrCreateUserFromOAuth(providerData({ emailVerified: true }));

      const { data } = prisma.account.update.mock.calls[0][0];
      expect(data).not.toHaveProperty('verifiedAt');
      expect(acceptPendingInvitesForUser).not.toHaveBeenCalled();
    });
  });
});
