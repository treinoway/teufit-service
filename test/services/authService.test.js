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
} from '../../src/services/authService.js';

import crypto from 'node:crypto';

function makeSession(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    get: (k) => store.get(k),
    set: (k, v) => store.set(k, v),
    delete: (k) => store.delete(k),
  };
}

describe('src/services/authService.js', () => {
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
          firstName: 'New',
          lastName: 'Trainer',
          birthDate: new Date('2000-01-01'),
        },
      });
      expect(res).toEqual({ created: true, role: Roles.TRAINER });
    });

    it('throws INVALID_PROFILE_TYPE for an unknown role', async () => {
      await expect(ensureProfileForUser({ userId: 'u1', role: 'admin' })).rejects.toMatchObject({
        code: 'INVALID_PROFILE_TYPE',
        statusCode: 400,
      });
    });
  });

  describe('authenticateWithGoogle', () => {
    it('exchanges code for token, fetches google profile, and calls findOrCreateUserFromOAuth with role from session', async () => {
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
        session: makeSession({ oauthRole: Roles.TRAINER }),
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
          role: Roles.TRAINER,
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
        session: makeSession({ oauthRole: Roles.TRAINER }),
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
        role: data.role,
        status: data.status,
        deletedAt: null,
      }));

      const user = await signupWithEmailPassword({
        email: '  Test@Example.com ',
        password: 'password123',
      });

      expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { email: 'test@example.com' } });
      expect(prisma.user.create).toHaveBeenCalled();

      const createCall = prisma.user.create.mock.calls[0][0];
      expect(createCall.data.email).toBe('test@example.com');
      expect(createCall.data.role).toBe('trainer');
      expect(createCall.data.passwordHash).toMatch(/^scrypt\$/);

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
        role: 'trainer',
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
        role: 'trainer',
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
        role: 'trainer',
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
});
