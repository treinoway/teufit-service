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
      trainer: {
        findFirst: vi.fn(),
        create: vi.fn(),
      },
      student: {
        findFirst: vi.fn(),
        create: vi.fn(),
      },
      passwordResetToken: {
        create: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
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

import { prisma } from '../../src/db.js';
import { findOrCreateUserFromOAuth } from '../../src/helpers/auth.js';
import { Roles } from '../../src/constants/roles.js';

import {
  authenticateWithGoogle,
  ensureProfileForUser,
  getCurrentUserWithAccounts,
  signupWithEmailPassword,
  loginWithEmailPassword,
  requestPasswordReset,
  resetPasswordWithToken,
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

describe('src/services/auth-service.js', () => {
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

    it('creates student profile if missing', async () => {
      prisma.student.findFirst.mockResolvedValue(null);
      prisma.student.create.mockResolvedValue({ id: 's1' });

      const res = await ensureProfileForUser({ userId: 'u1', role: Roles.STUDENT, profileSeed: { name: 'Alice' } });

      expect(prisma.student.findFirst).toHaveBeenCalledWith({ where: { userId: 'u1' } });
      expect(prisma.student.create).toHaveBeenCalledWith({
        data: {
          userId: 'u1',
        },
      });
      expect(res).toEqual({ created: true, role: Roles.STUDENT });
    });

    it('throws INVALID_PROFILE_TYPE for an unknown role', async () => {
      await expect(ensureProfileForUser({ userId: 'u1', role: 'admin' })).rejects.toMatchObject({
        code: 'INVALID_PROFILE_TYPE',
        statusCode: 400,
      });
    });
  });

  describe('authenticateWithGoogle', () => {
    it('exchanges code for token, fetches google profile, and calls findOrCreateUserFromOAuth with student role', async () => {
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
          roles: [Roles.STUDENT],
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
    it('normalizes email, hashes password, and creates a trainer user', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockImplementation(async ({ data }) => ({
        id: 'u1',
        ...data,
        roles: data.roles,
        status: data.status,
        deletedAt: null,
      }));

      const user = await signupWithEmailPassword({
        email: '  Test@Example.com ',
        password: 'password123',
      });

      expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { email: 'test@example.com' } });
      expect(prisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            email: 'test@example.com',
            roles: ['student'],
            passwordHash: expect.stringMatching(/^scrypt\$/),
          }),
        }),
      );

      // Returned user should not include passwordHash
      expect(user.passwordHash).toBeUndefined();
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
});
