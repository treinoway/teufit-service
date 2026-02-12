import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock modules that authService depends on.
vi.mock('../../src/db.js', () => {
  return {
    prisma: {
      user: {
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      account: {
        create: vi.fn(),
      },
      trainer: {
        findFirst: vi.fn(),
        create: vi.fn(),
      },
      passwordResetToken: {
        create: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      userWaitlist: {
        findUnique: vi.fn(),
        create: vi.fn(),
      },
      $transaction: vi.fn(async (ops) => {
        // Simple mock: if ops is an array of promises, resolve them.
        if (Array.isArray(ops)) {
          return Promise.all(ops);
        }
        // If ops is a callback, call it with the mocked prisma object.
        if (typeof ops === 'function') {
          return ops(prisma);
        }
        return ops;
      }),
    },
  };
});

vi.mock('../../src/helpers/auth.js', () => {
  return {
    findOrCreateUserFromOAuth: vi.fn(),
  };
});

vi.mock('../../src/services/token-service.js', () => {
  return {
    revokeAllUserRefreshTokens: vi.fn(),
  };
});

import { prisma } from '../../src/db.js';
import { findOrCreateUserFromOAuth } from '../../src/helpers/auth.js';
import { revokeAllUserRefreshTokens } from '../../src/services/token-service.js';
import { Roles } from '../../src/constants/roles.js';

import {
  authenticateWithGoogle,
  ensureProfileForUser,
  getCurrentUserWithAccounts,
  signupWithEmailPassword,
  loginWithEmailPassword,
  requestPasswordReset,
  resetPasswordWithToken,
  addEmailToWaitlist,
  changePassword,
} from '../../src/services/auth-service.js';

import crypto from 'node:crypto';

function makeSession(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    get: (k) => store.get(k),
    set: (k, v) => store.set(k, v),
    delete: (k) => store.delete(k),
  };
}

describe('authService', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  describe('getCurrentUserWithAccounts', () => {
    it('queries prisma.user.findUnique with include.accounts', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1' });

      const result = await getCurrentUserWithAccounts('u1');

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'u1' },
        include: {
          accounts: {
            select: {
              provider: true,
              createdAt: true,
            },
          },
        },
      });
      expect(result).toEqual({ id: 'u1' });
    });
  });

  describe('ensureProfileForUser', () => {
    it('creates trainer profile if missing', async () => {
      prisma.trainer.findFirst.mockResolvedValue(null);
      prisma.trainer.create.mockResolvedValue({ id: 't1' });

      const res = await ensureProfileForUser({ userId: 'u1', role: Roles.TRAINER });

      expect(prisma.trainer.findFirst).toHaveBeenCalledWith({ where: { userId: 'u1' } });
      expect(prisma.trainer.create).toHaveBeenCalledWith({
        data: {
          userId: 'u1',
        },
      });
      expect(res).toEqual({ created: true, role: Roles.TRAINER });
    });

    it('throws INVALID_PROFILE_TYPE for STUDENT role (removed)', async () => {
      await expect(ensureProfileForUser({ userId: 'u1', role: 'student' })).rejects.toMatchObject({
        code: 'INVALID_PROFILE_TYPE',
        statusCode: 400,
      });
    });

    it('throws INVALID_PROFILE_TYPE for an unknown role', async () => {
      await expect(ensureProfileForUser({ userId: 'u1', role: 'admin' })).rejects.toMatchObject({
        code: 'INVALID_PROFILE_TYPE',
        statusCode: 400,
      });
    });
  });

  describe('authenticateWithGoogle', () => {
    it('exchanges code for token, fetches google profile, and calls findOrCreateUserFromOAuth with empty roles', async () => {
      const token = {
        access_token: 'access',
        refresh_token: 'refresh',
        expires_in: 3600,
      };

      const fastify = {
        googleOAuth2: {
          getAccessTokenFromAuthorizationCodeFlow: vi.fn().mockResolvedValue({ token }),
        },
      };

      const request = {
        session: makeSession(),
      };

      fetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'gid',
          email: 'a@b.com',
          name: 'Alice',
          picture: 'pic',
        }),
      });

      findOrCreateUserFromOAuth.mockResolvedValue({ id: 'u1' });

      const res = await authenticateWithGoogle({ fastify, request });

      expect(fastify.googleOAuth2.getAccessTokenFromAuthorizationCodeFlow).toHaveBeenCalledWith(request);
      expect(fetch).toHaveBeenCalledWith('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: 'Bearer access' },
      });

      expect(findOrCreateUserFromOAuth).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'google',
          providerId: 'gid',
          email: 'a@b.com',
          name: 'Alice',
          avatar: 'pic',
          accessToken: 'access',
          refreshToken: 'refresh',
          expiresAt: token,
          roles: [],
        }),
      );

      expect(res.user).toEqual({ id: 'u1' });
      expect(res.token).toEqual(token);
      expect(res.googleUser).toMatchObject({ id: 'gid' });
    });

    it('throws GOOGLE_PROFILE_FETCH_FAILED when google profile fetch returns non-ok', async () => {
      const token = { access_token: 'access', expires_in: 3600 };

      const fastify = {
        googleOAuth2: {
          getAccessTokenFromAuthorizationCodeFlow: vi.fn().mockResolvedValue({ token }),
        },
      };

      const request = {
        session: makeSession(),
      };

      fetch.mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'nope',
      });

      await expect(authenticateWithGoogle({ fastify, request })).rejects.toMatchObject({
        code: 'GOOGLE_PROFILE_FETCH_FAILED',
        statusCode: 502,
      });
    });
  });

  describe('signupWithEmailPassword', () => {
    it('normalizes email, hashes password, creates user and account in transaction', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      // Mock the transaction callback
      prisma.$transaction.mockImplementation(async (callback) => {
        const txPrisma = {
          user: {
            create: vi.fn().mockResolvedValue({
              id: 'u1',
              email: 'test@example.com',
              passwordHash: 'scrypt$...',
              roles: [],
              status: 'pending',
              deletedAt: null,
            }),
          },
          account: {
            create: vi.fn().mockResolvedValue({
              id: 'a1',
              userId: 'u1',
              provider: 'email',
              providerId: 'test@example.com',
            }),
          },
        };

        const result = await callback(txPrisma);

        // Store the calls for assertions
        prisma.user.create = txPrisma.user.create;
        prisma.account.create = txPrisma.account.create;

        return result;
      });

      const user = await signupWithEmailPassword({
        email: '  Test@Example.com ',
        password: 'password123',
      });

      expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { email: 'test@example.com' } });
      expect(prisma.$transaction).toHaveBeenCalled();
      expect(prisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            email: 'test@example.com',
            roles: [],
            passwordHash: expect.stringMatching(/^scrypt\$/),
          }),
        }),
      );
      expect(prisma.account.create).toHaveBeenCalledWith({
        data: {
          userId: 'u1',
          provider: 'email',
          providerId: 'test@example.com',
        },
      });

      // Returned user should not include passwordHash
      expect(user.passwordHash).toBeUndefined();
      expect(user.id).toBe('u1');
    });

    it('rejects weak passwords', async () => {
      await expect(
        signupWithEmailPassword({
          email: 'a@b.com',
          password: 'short',
        }),
      ).rejects.toMatchObject({ code: 'WEAK_PASSWORD', statusCode: 400 });
    });
  });

  describe('loginWithEmailPassword', () => {
    function makeHash(password) {
      const salt = crypto.randomBytes(16);
      const keylen = 64;
      const N = 16384;
      const r = 8;
      const p = 1;
      const derivedKey = crypto.scryptSync(password, salt, keylen, { N, r, p });
      return `scrypt$N=${N},r=${r},p=${p}$${salt.toString('base64')}$${derivedKey.toString('base64')}`;
    }

    it('logs in with correct credentials and does not expose passwordHash', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: 'test@example.com',
        roles: ['trainer'],
        status: 'pending',
        username: null,
        avatar: null,
        deletedAt: null,
        passwordHash: makeHash('password123'),
      });

      const user = await loginWithEmailPassword({ email: 'TEST@EXAMPLE.COM', password: 'password123' });
      expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { email: 'test@example.com' } });
      expect(user.passwordHash).toBeUndefined();
      expect(user.id).toBe('u1');
    });

    it('rejects invalid credentials', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: 'test@example.com',
        roles: ['trainer'],
        status: 'pending',
        username: null,
        avatar: null,
        deletedAt: null,
        passwordHash: makeHash('password123'),
      });

      await expect(loginWithEmailPassword({ email: 'test@example.com', password: 'wrong' })).rejects.toMatchObject({
        code: 'INVALID_CREDENTIALS',
        statusCode: 401,
      });
    });

    it('rejects users without passwordHash (OAuth-only accounts)', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: 'test@example.com',
        roles: ['trainer'],
        status: 'pending',
        deletedAt: null,
        passwordHash: null,
      });

      await expect(loginWithEmailPassword({ email: 'test@example.com', password: 'password123' })).rejects.toMatchObject({
        code: 'PASSWORD_NOT_SET',
        statusCode: 409,
      });
    });
  });

  describe('password reset flow', () => {
    it('requestPasswordReset creates a token when user exists', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: 'test@example.com',
        deletedAt: null,
      });

      const res = await requestPasswordReset({ email: 'test@example.com' });

      expect(prisma.passwordResetToken.create).toHaveBeenCalled();
      expect(typeof res.resetToken).toBe('string');
      expect(res.resetToken.length).toBeGreaterThan(0);
    });

    it('requestPasswordReset does nothing visible when user does not exist', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      const res = await requestPasswordReset({ email: 'missing@example.com' });

      expect(prisma.passwordResetToken.create).not.toHaveBeenCalled();
      expect(res.resetToken).toBeNull();
    });

    it('resetPasswordWithToken updates password and marks token as used when confirmation matches', async () => {
      const now = new Date();

      prisma.passwordResetToken.findUnique.mockResolvedValue({
        tokenHash: 'hash',
        userId: 'u1',
        used: false,
        expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
        user: {
          id: 'u1',
          email: 'test@example.com',
          deletedAt: null,
        },
      });

      prisma.$transaction.mockImplementation(async () => {
        // Simulate prisma.user.update returning the updated user
        return [
          {
            id: 'u1',
            email: 'test@example.com',
            passwordHash: 'new-hash',
            deletedAt: null,
          },
        ];
      });

      const user = await resetPasswordWithToken({ token: 'plain-token', password: 'new-password123', passwordConfirmation: 'new-password123' });

      expect(prisma.passwordResetToken.findUnique).toHaveBeenCalled();
      expect(prisma.$transaction).toHaveBeenCalled();
      expect(user.id).toBe('u1');
      expect(user.passwordHash).toBeUndefined();
    });

  it('resetPasswordWithToken rejects when password confirmation does not match', async () => {
    await expect(
    resetPasswordWithToken({ token: 'plain-token', password: 'new-password123', passwordConfirmation: 'other-pass' }),
    ).rejects.toMatchObject({
    code: 'PASSWORD_MISMATCH',
    statusCode: 400,
    });
  });
  });

  describe('addEmailToWaitlist', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('successfully adds a new email to the waitlist', async () => {
      const email = 'user@example.com';
      const mockWaitlistEntry = {
        id: 'w1',
        email: email.toLowerCase(),
        status: 'pending',
        createdAt: new Date(),
      };

      prisma.userWaitlist.findUnique.mockResolvedValue(null);
      prisma.userWaitlist.create.mockResolvedValue(mockWaitlistEntry);

      const result = await addEmailToWaitlist({ email });

      expect(prisma.userWaitlist.findUnique).toHaveBeenCalledWith({
        where: { email: email.toLowerCase() },
      });
      expect(prisma.userWaitlist.create).toHaveBeenCalledWith({
        data: {
          email: email.toLowerCase(),
          status: 'pending',
        },
      });
      expect(result).toEqual({
        id: mockWaitlistEntry.id,
        email: mockWaitlistEntry.email,
        status: mockWaitlistEntry.status,
        createdAt: mockWaitlistEntry.createdAt,
      });
    });

    it('converts email to lowercase before storing', async () => {
      const email = 'USER@EXAMPLE.COM';
      const mockWaitlistEntry = {
        id: 'w2',
        email: 'user@example.com',
        status: 'pending',
        createdAt: new Date(),
      };

      prisma.userWaitlist.findUnique.mockResolvedValue(null);
      prisma.userWaitlist.create.mockResolvedValue(mockWaitlistEntry);

      await addEmailToWaitlist({ email });

      expect(prisma.userWaitlist.findUnique).toHaveBeenCalledWith({
        where: { email: 'user@example.com' },
      });
      expect(prisma.userWaitlist.create).toHaveBeenCalledWith({
        data: {
          email: 'user@example.com',
          status: 'pending',
        },
      });
    });

    it('throws EMAIL_REQUIRED when email is missing', async () => {
      await expect(addEmailToWaitlist({ email: '' })).rejects.toMatchObject({
        code: 'EMAIL_REQUIRED',
        message: 'Valid email is required',
      });

      await expect(addEmailToWaitlist({ email: null })).rejects.toMatchObject({
        code: 'EMAIL_REQUIRED',
      });

      await expect(addEmailToWaitlist({})).rejects.toMatchObject({
        code: 'EMAIL_REQUIRED',
      });
    });

    it('throws EMAIL_REQUIRED when email is not a string', async () => {
      await expect(addEmailToWaitlist({ email: 123 })).rejects.toMatchObject({
        code: 'EMAIL_REQUIRED',
        message: 'Valid email is required',
      });

      await expect(addEmailToWaitlist({ email: {} })).rejects.toMatchObject({
        code: 'EMAIL_REQUIRED',
      });
    });

    it('throws EMAIL_ALREADY_ON_WAITLIST when email already exists', async () => {
      const email = 'existing@example.com';
      const existingEntry = {
        id: 'w3',
        email: email.toLowerCase(),
        status: 'pending',
        createdAt: new Date(),
      };

      prisma.userWaitlist.findUnique.mockResolvedValue(existingEntry);

      await expect(addEmailToWaitlist({ email })).rejects.toMatchObject({
        code: 'EMAIL_ALREADY_ON_WAITLIST',
        message: 'Email already on waitlist',
      });

      expect(prisma.userWaitlist.findUnique).toHaveBeenCalledWith({
        where: { email: email.toLowerCase() },
      });
      expect(prisma.userWaitlist.create).not.toHaveBeenCalled();
    });
  });

  describe('changePassword', () => {
    function makeHash(password) {
      const salt = crypto.randomBytes(16);
      const keylen = 64;
      const N = 16384;
      const r = 8;
      const p = 1;
      const derivedKey = crypto.scryptSync(password, salt, keylen, { N, r, p });
      return `scrypt$N=${N},r=${r},p=${p}$${salt.toString('base64')}$${derivedKey.toString('base64')}`;
    }

    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('successfully changes password when all validations pass', async () => {
      const userId = 'u1';
      const currentPassword = 'oldPassword123';
      const newPassword = 'newPassword456';
      const newPasswordConfirmation = 'newPassword456';

      const mockUser = {
        id: userId,
        email: 'user@example.com',
        passwordHash: makeHash(currentPassword),
        deletedAt: null,
        roles: [],
      };

      prisma.user.findUnique.mockResolvedValue(mockUser);
      prisma.user.update.mockResolvedValue({
        ...mockUser,
        passwordHash: makeHash(newPassword),
      });
      revokeAllUserRefreshTokens.mockResolvedValue(undefined);

      const result = await changePassword({
        userId,
        currentPassword,
        newPassword,
        newPasswordConfirmation,
      });

      expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: userId } });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: userId },
        data: { passwordHash: expect.stringMatching(/^scrypt\$/) },
      });
      expect(revokeAllUserRefreshTokens).toHaveBeenCalledWith(userId);
      expect(result.success).toBe(true);
      expect(result.user.passwordHash).toBeUndefined();
    });

    it('throws USER_ID_REQUIRED when userId is missing', async () => {
      await expect(
        changePassword({
          userId: null,
          currentPassword: 'current',
          newPassword: 'newPassword123',
          newPasswordConfirmation: 'newPassword123',
        }),
      ).rejects.toMatchObject({
        code: 'USER_ID_REQUIRED',
        statusCode: 400,
      });
    });

    it('throws CURRENT_PASSWORD_REQUIRED when currentPassword is missing', async () => {
      await expect(
        changePassword({
          userId: 'u1',
          currentPassword: '',
          newPassword: 'newPassword123',
          newPasswordConfirmation: 'newPassword123',
        }),
      ).rejects.toMatchObject({
        code: 'CURRENT_PASSWORD_REQUIRED',
        statusCode: 400,
      });
    });

    it('throws WEAK_PASSWORD when new password is too short', async () => {
      await expect(
        changePassword({
          userId: 'u1',
          currentPassword: 'oldPassword123',
          newPassword: 'short',
          newPasswordConfirmation: 'short',
        }),
      ).rejects.toMatchObject({
        code: 'WEAK_PASSWORD',
        statusCode: 400,
      });
    });

    it('throws PASSWORD_MISMATCH when new passwords do not match', async () => {
      await expect(
        changePassword({
          userId: 'u1',
          currentPassword: 'oldPassword123',
          newPassword: 'newPassword123',
          newPasswordConfirmation: 'differentPassword456',
        }),
      ).rejects.toMatchObject({
        code: 'PASSWORD_MISMATCH',
        statusCode: 400,
        message: 'New passwords do not match',
      });
    });

    it('throws USER_NOT_FOUND when user does not exist', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        changePassword({
          userId: 'nonexistent',
          currentPassword: 'oldPassword123',
          newPassword: 'newPassword456',
          newPasswordConfirmation: 'newPassword456',
        }),
      ).rejects.toMatchObject({
        code: 'USER_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws USER_DELETED when user account is deactivated', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: 'user@example.com',
        passwordHash: makeHash('oldPassword123'),
        deletedAt: new Date(),
      });

      await expect(
        changePassword({
          userId: 'u1',
          currentPassword: 'oldPassword123',
          newPassword: 'newPassword456',
          newPasswordConfirmation: 'newPassword456',
        }),
      ).rejects.toMatchObject({
        code: 'USER_DELETED',
        statusCode: 403,
      });
    });

    it('throws PASSWORD_NOT_SET when user has no passwordHash (OAuth-only)', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: 'user@example.com',
        passwordHash: null,
        deletedAt: null,
      });

      await expect(
        changePassword({
          userId: 'u1',
          currentPassword: 'oldPassword123',
          newPassword: 'newPassword456',
          newPasswordConfirmation: 'newPassword456',
        }),
      ).rejects.toMatchObject({
        code: 'PASSWORD_NOT_SET',
        statusCode: 409,
      });
    });

    it('throws INVALID_CURRENT_PASSWORD when current password is incorrect', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: 'user@example.com',
        passwordHash: makeHash('correctPassword123'),
        deletedAt: null,
      });

      await expect(
        changePassword({
          userId: 'u1',
          currentPassword: 'wrongPassword',
          newPassword: 'newPassword456',
          newPasswordConfirmation: 'newPassword456',
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_CURRENT_PASSWORD',
        statusCode: 401,
      });
    });

    it('throws PASSWORD_SAME_AS_CURRENT when new password equals current password', async () => {
      const password = 'samePassword123';
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: 'user@example.com',
        passwordHash: makeHash(password),
        deletedAt: null,
      });

      await expect(
        changePassword({
          userId: 'u1',
          currentPassword: password,
          newPassword: password,
          newPasswordConfirmation: password,
        }),
      ).rejects.toMatchObject({
        code: 'PASSWORD_SAME_AS_CURRENT',
        statusCode: 400,
      });
    });
  });
});
