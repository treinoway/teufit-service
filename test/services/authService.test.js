import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock modules that authService depends on.
vi.mock('../../src/db.js', () => {
  return {
    prisma: {
      user: {
        findUnique: vi.fn(),
      },
      student: {
        findFirst: vi.fn(),
        create: vi.fn(),
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
} from '../../src/services/authService.js';

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
    it('creates student profile if missing', async () => {
      prisma.student.findFirst.mockResolvedValue(null);
      prisma.student.create.mockResolvedValue({ id: 's1' });

      const res = await ensureProfileForUser({ userId: 'u1', role: Roles.STUDENT });

      expect(prisma.student.findFirst).toHaveBeenCalledWith({ where: { userId: 'u1' } });
      expect(prisma.student.create).toHaveBeenCalledWith({
        data: {
          userId: 'u1',
          name: 'New Student',
          birthdate: new Date('2000-01-01'),
        },
      });
      expect(res).toEqual({ created: true, role: Roles.STUDENT });
    });

    it('does not create student profile if it already exists', async () => {
      prisma.student.findFirst.mockResolvedValue({ id: 's1' });

      const res = await ensureProfileForUser({ userId: 'u1', role: Roles.STUDENT });

      expect(prisma.student.create).not.toHaveBeenCalled();
      expect(res).toEqual({ created: false, role: Roles.STUDENT });
    });

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
        session: makeSession({ oauthRole: Roles.STUDENT }),
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
          role: Roles.STUDENT,
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
        session: makeSession({ oauthRole: Roles.STUDENT }),
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
});
