import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock modules that authService depends on.
vi.mock('../../src/db.js', () => {
  return {
    prisma: {
      user: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
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
        findFirst: vi.fn(),
        findMany: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
        deleteMany: vi.fn(),
      },
      userWaitlist: {
        findUnique: vi.fn(),
        create: vi.fn(),
      },
      refreshToken: {
        updateMany: vi.fn(),
      },
      $queryRaw: vi.fn(),
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

vi.mock('../../src/services/email-verification-service.js', () => {
  return {
    markEmailVerifiedFromInboxProof: vi.fn(),
  };
});

import { prisma } from '../../src/db.js';
import { markEmailVerifiedFromInboxProof } from '../../src/services/email-verification-service.js';
import { findOrCreateUserFromOAuth } from '../../src/helpers/auth.js';
import { revokeAllUserRefreshTokens } from '../../src/services/token-service.js';
import { Roles } from '../../src/constants/roles.js';

import {
  authenticateWithGoogle,
  ensureProfileForUser,
  getCurrentUserWithAccounts,
  loginWithEmailPassword,
  requestPasswordReset,
  resetPasswordWithCode,
  addEmailToWaitlist,
  changePassword,
} from '../../src/services/auth-service.js';

import crypto from 'node:crypto';
import config from '../../config/index.js';
import defaultEnv from '../../config/environments/default.js';
import developmentEnv from '../../config/environments/development.js';
import stagingEnv from '../../config/environments/staging.js';
import testEnv from '../../config/environments/test.js';
import ptBR from '../../src/i18n/locales/pt-BR.js';
import enUS from '../../src/i18n/locales/en-US.js';
import {
  NIL_UUID,
  PASSWORD_RESET_ISSUE_WINDOW_MS,
  PASSWORD_RESET_MAX_ATTEMPTS,
  PASSWORD_RESET_TTL_MS,
  PasswordResetErrorCode,
  PasswordResetMessageCode,
} from '../../src/constants/password-reset.js';

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

    it('uses the given transaction client instead of the global one', async () => {
      const tx = { trainer: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 't1' }) } };

      const res = await ensureProfileForUser({ userId: 'u1', role: Roles.TRAINER, tx });

      expect(tx.trainer.create).toHaveBeenCalledWith({ data: { userId: 'u1' } });
      expect(prisma.trainer.findFirst).not.toHaveBeenCalled();
      expect(prisma.trainer.create).not.toHaveBeenCalled();
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

  describe('authenticateWithGoogle emailVerified propagation', () => {
    async function runWithProfile(profile) {
      const fastify = {
        googleOAuth2: {
          getAccessTokenFromAuthorizationCodeFlow: vi
            .fn()
            .mockResolvedValue({ token: { access_token: 'access', refresh_token: 'refresh', expires_in: 3600 } }),
        },
      };
      fetch.mockResolvedValue({ ok: true, json: async () => ({ id: 'gid', email: 'a@b.com', ...profile }) });
      findOrCreateUserFromOAuth.mockResolvedValue({ id: 'u1' });
      await authenticateWithGoogle({ fastify, request: { session: makeSession() } });
    }

    it('passes emailVerified true when Google reports verified_email true', async () => {
      await runWithProfile({ verified_email: true });

      expect(findOrCreateUserFromOAuth).toHaveBeenCalledWith(expect.objectContaining({ emailVerified: true }));
    });

    it('passes emailVerified false when verified_email is missing', async () => {
      await runWithProfile({});

      expect(findOrCreateUserFromOAuth).toHaveBeenCalledWith(expect.objectContaining({ emailVerified: false }));
    });

    it('passes emailVerified false when verified_email is a truthy non-boolean', async () => {
      await runWithProfile({ verified_email: 'true' });

      expect(findOrCreateUserFromOAuth).toHaveBeenCalledWith(expect.objectContaining({ emailVerified: false }));
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
      prisma.$queryRaw.mockResolvedValue([{ id: 'u1' }]);
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
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(prisma.$queryRaw.mock.calls[0][1]).toBe('test@example.com');
      expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 'u1' } });
      expect(user.passwordHash).toBeUndefined();
      expect(user.id).toBe('u1');
    });

    it('rejects invalid credentials', async () => {
      prisma.$queryRaw.mockResolvedValue([{ id: 'u1' }]);
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

    it('rejects users without passwordHash (OAuth-only accounts) as INVALID_CREDENTIALS, not PASSWORD_NOT_SET', async () => {
      prisma.$queryRaw.mockResolvedValue([{ id: 'u1' }]);
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: 'test@example.com',
        roles: ['trainer'],
        status: 'pending',
        deletedAt: null,
        passwordHash: null,
      });

      await expect(loginWithEmailPassword({ email: 'test@example.com', password: 'password123' })).rejects.toMatchObject({
        code: 'INVALID_CREDENTIALS',
        statusCode: 401,
      });
    });

    it('rejects an unknown email as INVALID_CREDENTIALS after burning a dummy scrypt', async () => {
      prisma.$queryRaw.mockResolvedValue([]);
      const scryptSpy = vi.spyOn(crypto, 'scryptSync');

      await expect(loginWithEmailPassword({ email: 'nobody@example.com', password: 'password123' })).rejects.toMatchObject({
        code: 'INVALID_CREDENTIALS',
        statusCode: 401,
      });

      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(scryptSpy).toHaveBeenCalledTimes(1);
      expect(scryptSpy.mock.calls[0][3]).toEqual({ N: 16384, r: 8, p: 1 });
    });

    it('burns the same scrypt cost for an OAuth-only account as for a wrong password', async () => {
      prisma.$queryRaw.mockResolvedValue([{ id: 'u1' }]);
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'test@example.com', deletedAt: null, passwordHash: null });
      const scryptSpy = vi.spyOn(crypto, 'scryptSync');

      await expect(loginWithEmailPassword({ email: 'test@example.com', password: 'password123' })).rejects.toMatchObject({
        code: 'INVALID_CREDENTIALS',
      });

      expect(scryptSpy).toHaveBeenCalledTimes(1);
    });

    it('rejects a deleted account with a wrong password as INVALID_CREDENTIALS (USER_DELETED not revealed)', async () => {
      prisma.$queryRaw.mockResolvedValue([{ id: 'u1' }]);
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: 'test@example.com',
        deletedAt: new Date(),
        passwordHash: makeHash('password123'),
      });

      await expect(loginWithEmailPassword({ email: 'test@example.com', password: 'wrong-password' })).rejects.toMatchObject({
        code: 'INVALID_CREDENTIALS',
        statusCode: 401,
      });
    });

    it('throws USER_DELETED for a deleted account only after the password matched', async () => {
      prisma.$queryRaw.mockResolvedValue([{ id: 'u1' }]);
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: 'test@example.com',
        deletedAt: new Date(),
        passwordHash: makeHash('password123'),
      });

      await expect(loginWithEmailPassword({ email: 'test@example.com', password: 'password123' })).rejects.toMatchObject({
        code: 'USER_DELETED',
        statusCode: 403,
      });
    });
  });

  describe('password reset flow', () => {
    const EMAIL = 'test@example.com';
    const USER_ID = 'u1';
    const CODE = '123456';
    const NEW_PASSWORD = 'new-password123';
    const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

    const resetInput = (overrides = {}) => ({
      email: EMAIL,
      code: CODE,
      password: NEW_PASSWORD,
      passwordConfirmation: NEW_PASSWORD,
      ...overrides,
    });

    const activeToken = (overrides = {}) => ({
      id: 't1',
      userId: USER_ID,
      tokenHash: sha256(CODE),
      used: false,
      attempts: 0,
      expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
      ...overrides,
    });

    beforeEach(() => {
      prisma.$transaction.mockImplementation(async (ops) => (Array.isArray(ops) ? Promise.all(ops) : ops(prisma)));
      prisma.passwordResetToken.findMany.mockResolvedValue([]);
      prisma.passwordResetToken.findFirst.mockResolvedValue(null);
      prisma.passwordResetToken.updateMany.mockResolvedValue({ count: 1 });
      prisma.passwordResetToken.deleteMany.mockResolvedValue({ count: 0 });
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });
    });

    describe('requestPasswordReset', () => {
      beforeEach(() => {
        prisma.$queryRaw.mockResolvedValue([{ id: USER_ID }]);
        prisma.user.findUnique.mockResolvedValue({ id: USER_ID, email: EMAIL, deletedAt: null });
      });

      it('should create a 6-digit code stored only as a sha256 hash when the user exists', async () => {
        const res = await requestPasswordReset({ email: EMAIL });

        expect(res.resetToken).toMatch(/^[0-9]{6}$/);
        expect(res.deliveryEmail).toBe(EMAIL);
        expect(prisma.passwordResetToken.create).toHaveBeenCalledWith({
          data: { tokenHash: sha256(res.resetToken), userId: USER_ID, expiresAt: expect.any(Date) },
        });
      });

      it('should mark prior unused rows as used and purge rows older than the issue window', async () => {
        await requestPasswordReset({ email: EMAIL });

        expect(prisma.passwordResetToken.updateMany).toHaveBeenCalledWith({
          where: { userId: USER_ID, used: false },
          data: { used: true },
        });
        const { where } = prisma.passwordResetToken.deleteMany.mock.calls[0][0];
        expect(where.userId).toBe(USER_ID);
        const cutoffAge = Date.now() - where.createdAt.lt.getTime();
        expect(cutoffAge).toBeGreaterThanOrEqual(PASSWORD_RESET_ISSUE_WINDOW_MS - 1000);
        expect(cutoffAge).toBeLessThan(PASSWORD_RESET_ISSUE_WINDOW_MS + 1000);
      });

      it('should expire the code after the configured TTL', async () => {
        await requestPasswordReset({ email: EMAIL });

        const { expiresAt } = prisma.passwordResetToken.create.mock.calls[0][0].data;
        expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(PASSWORD_RESET_TTL_MS - 1000);
        expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(PASSWORD_RESET_TTL_MS);
      });

      it('should return nulls and create nothing when the user does not exist', async () => {
        prisma.$queryRaw.mockResolvedValue([]);

        const res = await requestPasswordReset({ email: 'missing@example.com' });

        expect(prisma.passwordResetToken.create).not.toHaveBeenCalled();
        expect(res).toEqual({ resetToken: null, deliveryEmail: null });
      });

      it('should return nulls and create nothing when the user is soft-deleted', async () => {
        prisma.user.findUnique.mockResolvedValue({ id: USER_ID, email: EMAIL, deletedAt: new Date() });

        const res = await requestPasswordReset({ email: EMAIL });

        expect(prisma.passwordResetToken.create).not.toHaveBeenCalled();
        expect(res).toEqual({ resetToken: null, deliveryEmail: null });
      });

      it('should throw a ValidationAppError with auth.email.required when email is missing', async () => {
        await expect(requestPasswordReset({ email: '   ' })).rejects.toMatchObject({
          httpStatus: 400,
          error: 'VALIDATION_ERROR',
          messageCode: PasswordResetMessageCode.EMAIL_REQUIRED,
          details: [{ field: 'email', reason: PasswordResetErrorCode.EMAIL_REQUIRED }],
        });
      });

      describe('silent throttle', () => {
        const originalAuth = { ...config.auth };
        afterEach(() => {
          Object.assign(config.auth, originalAuth);
        });

        it('should create nothing when the latest code is inside the cooldown', async () => {
          config.auth.passwordResetCooldownMs = 60_000;
          config.auth.passwordResetMaxPerHour = 5;
          prisma.passwordResetToken.findMany.mockResolvedValue([{ createdAt: new Date(Date.now() - 10_000) }]);

          const res = await requestPasswordReset({ email: EMAIL });

          expect(res).toEqual({ resetToken: null, deliveryEmail: null });
          expect(prisma.passwordResetToken.create).not.toHaveBeenCalled();
          expect(prisma.passwordResetToken.updateMany).not.toHaveBeenCalled();
        });

        it('should issue a code once the cooldown has elapsed', async () => {
          config.auth.passwordResetCooldownMs = 60_000;
          config.auth.passwordResetMaxPerHour = 5;
          prisma.passwordResetToken.findMany.mockResolvedValue([{ createdAt: new Date(Date.now() - 61_000) }]);

          const res = await requestPasswordReset({ email: EMAIL });

          expect(res.resetToken).toMatch(/^[0-9]{6}$/);
        });

        it('should create nothing when the hourly cap is reached', async () => {
          config.auth.passwordResetCooldownMs = 0;
          config.auth.passwordResetMaxPerHour = 2;
          prisma.passwordResetToken.findMany.mockResolvedValue([
            { createdAt: new Date(Date.now() - 20 * 60_000) },
            { createdAt: new Date(Date.now() - 30 * 60_000) },
          ]);

          const res = await requestPasswordReset({ email: EMAIL });

          expect(res).toEqual({ resetToken: null, deliveryEmail: null });
          expect(prisma.passwordResetToken.create).not.toHaveBeenCalled();
        });

        it('should only count rows inside the one-hour window and cap the query at the hourly max', async () => {
          config.auth.passwordResetMaxPerHour = 3;

          await requestPasswordReset({ email: EMAIL });

          const query = prisma.passwordResetToken.findMany.mock.calls[0][0];
          expect(query.take).toBe(3);
          expect(query.where.userId).toBe(USER_ID);
          expect(Date.now() - query.where.createdAt.gte.getTime()).toBeGreaterThanOrEqual(PASSWORD_RESET_ISSUE_WINDOW_MS - 1000);
        });
      });
    });

    describe('resetPasswordWithCode validation', () => {
      it.each([
        ['email is missing', { email: '' }, 'email', PasswordResetMessageCode.EMAIL_REQUIRED],
        ['code is missing', { code: undefined }, 'code', PasswordResetMessageCode.CODE_REQUIRED],
        ['code is blank', { code: '  ' }, 'code', PasswordResetMessageCode.CODE_REQUIRED],
        ['password is shorter than 8 characters', { password: 'short', passwordConfirmation: 'short' }, 'password', PasswordResetMessageCode.WEAK_PASSWORD],
        ['confirmation does not match', { passwordConfirmation: 'other-pass1' }, 'passwordConfirmation', PasswordResetMessageCode.PASSWORD_MISMATCH],
      ])('should throw VALIDATION_ERROR when %s', async (_label, overrides, field, messageCode) => {
        await expect(resetPasswordWithCode(resetInput(overrides))).rejects.toMatchObject({
          httpStatus: 400,
          error: 'VALIDATION_ERROR',
          messageCode,
          details: [{ field, reason: expect.any(String) }],
        });
        expect(prisma.passwordResetToken.updateMany).not.toHaveBeenCalled();
      });
    });

    describe('resetPasswordWithCode invalid code', () => {
      const INVALID = {
        httpStatus: 400,
        error: PasswordResetErrorCode.INVALID_CODE,
        messageCode: PasswordResetMessageCode.INVALID_CODE,
        message: 'Invalid or expired code. Request a new one.',
      };

      beforeEach(() => {
        prisma.$queryRaw.mockResolvedValue([{ id: USER_ID }]);
        prisma.user.findUnique.mockResolvedValue({ id: USER_ID, deletedAt: null });
        prisma.passwordResetToken.findFirst.mockResolvedValue(activeToken());
      });

      async function captureError(overrides) {
        try {
          await resetPasswordWithCode(resetInput(overrides));
        } catch (error) {
          return error;
        }
        throw new Error('expected rejection');
      }

      it('should throw the uniform error for an unknown email', async () => {
        prisma.$queryRaw.mockResolvedValue([]);
        prisma.passwordResetToken.findFirst.mockResolvedValue(null);

        await expect(resetPasswordWithCode(resetInput())).rejects.toMatchObject(INVALID);
      });

      it('should throw the uniform error for a deleted user even with the right code', async () => {
        prisma.user.findUnique.mockResolvedValue({ id: USER_ID, deletedAt: new Date() });

        await expect(resetPasswordWithCode(resetInput())).rejects.toMatchObject(INVALID);
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it('should throw the uniform error when there is no active token', async () => {
        prisma.passwordResetToken.findFirst.mockResolvedValue(null);

        await expect(resetPasswordWithCode(resetInput())).rejects.toMatchObject(INVALID);
      });

      it('should throw the uniform error for a wrong code', async () => {
        await expect(resetPasswordWithCode(resetInput({ code: '000000' }))).rejects.toMatchObject(INVALID);
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it('should throw the uniform error when the attempt cannot be consumed (cap reached) even with the right code', async () => {
        prisma.passwordResetToken.updateMany.mockResolvedValue({ count: 0 });

        await expect(resetPasswordWithCode(resetInput())).rejects.toMatchObject(INVALID);
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it('should look up only unused, unexpired tokens for the user, newest first', async () => {
        await resetPasswordWithCode(resetInput());

        expect(prisma.passwordResetToken.findFirst).toHaveBeenCalledWith({
          where: { userId: USER_ID, used: false, expiresAt: { gt: expect.any(Date) } },
          orderBy: { createdAt: 'desc' },
        });
      });

      it('should consume an attempt atomically with a conditional increment bounded by the cap', async () => {
        await resetPasswordWithCode(resetInput({ code: '000000' })).catch(() => {});

        expect(prisma.passwordResetToken.updateMany).toHaveBeenCalledWith({
          where: {
            id: 't1',
            used: false,
            attempts: { lt: PASSWORD_RESET_MAX_ATTEMPTS },
            expiresAt: { gt: expect.any(Date) },
          },
          data: { attempts: { increment: 1 } },
        });
      });

      it('should still consume an attempt (against a nil id) for an unknown email', async () => {
        prisma.$queryRaw.mockResolvedValue([]);
        prisma.passwordResetToken.findFirst.mockResolvedValue(null);

        await resetPasswordWithCode(resetInput()).catch(() => {});

        expect(prisma.passwordResetToken.findFirst.mock.calls[0][0].where.userId).toBe(NIL_UUID);
        expect(prisma.passwordResetToken.updateMany.mock.calls[0][0].where.id).toBe(NIL_UUID);
      });

      it('should produce identical errors across every failure cause', async () => {
        const errors = [];

        prisma.$queryRaw.mockResolvedValue([]);
        prisma.passwordResetToken.findFirst.mockResolvedValue(null);
        errors.push(await captureError());

        prisma.$queryRaw.mockResolvedValue([{ id: USER_ID }]);
        prisma.user.findUnique.mockResolvedValue({ id: USER_ID, deletedAt: new Date() });
        prisma.passwordResetToken.findFirst.mockResolvedValue(activeToken());
        errors.push(await captureError());

        prisma.user.findUnique.mockResolvedValue({ id: USER_ID, deletedAt: null });
        prisma.passwordResetToken.findFirst.mockResolvedValue(null);
        errors.push(await captureError());

        prisma.passwordResetToken.findFirst.mockResolvedValue(activeToken());
        errors.push(await captureError({ code: '000000' }));

        prisma.passwordResetToken.updateMany.mockResolvedValue({ count: 0 });
        errors.push(await captureError());

        const shapes = errors.map(({ httpStatus, error, messageCode, message, details }) => ({
          httpStatus, error, messageCode, message, details,
        }));
        for (const shape of shapes) expect(shape).toEqual(shapes[0]);
        expect(shapes[0].error).toBe(PasswordResetErrorCode.INVALID_CODE);
      });

      it('should throw the uniform error when a concurrent request already used the token', async () => {
        prisma.passwordResetToken.updateMany
          .mockResolvedValueOnce({ count: 1 }) // attempt consumed
          .mockResolvedValueOnce({ count: 0 }); // token already used by the other request

        await expect(resetPasswordWithCode(resetInput())).rejects.toMatchObject(INVALID);
        expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
        expect(prisma.user.update).not.toHaveBeenCalled();
        expect(markEmailVerifiedFromInboxProof).not.toHaveBeenCalled();
      });

      it('should not mark the email verified when the code is wrong', async () => {
        await expect(resetPasswordWithCode(resetInput({ code: '000000' }))).rejects.toBeDefined();

        expect(markEmailVerifiedFromInboxProof).not.toHaveBeenCalled();
      });
    });

    describe('resetPasswordWithCode success', () => {
      beforeEach(() => {
        prisma.$queryRaw.mockResolvedValue([{ id: USER_ID }]);
        prisma.user.findUnique.mockResolvedValue({ id: USER_ID, deletedAt: null });
        prisma.passwordResetToken.findFirst.mockResolvedValue(activeToken());
        prisma.user.update.mockResolvedValue({ id: USER_ID, email: EMAIL, passwordHash: 'new-hash', deletedAt: null });
      });

      it('should update the password, strip passwordHash and mark the email verified', async () => {
        const user = await resetPasswordWithCode(resetInput());

        expect(prisma.user.update).toHaveBeenCalledWith({
          where: { id: USER_ID },
          data: { passwordHash: expect.any(String) },
        });
        expect(prisma.user.update.mock.calls[0][0].data.passwordHash).not.toBe(NEW_PASSWORD);
        expect(user.id).toBe(USER_ID);
        expect(user.passwordHash).toBeUndefined();
        expect(markEmailVerifiedFromInboxProof).toHaveBeenCalledWith(prisma, expect.objectContaining({ id: USER_ID, email: EMAIL }));
      });

      it('should mark the token used', async () => {
        await resetPasswordWithCode(resetInput());

        expect(prisma.passwordResetToken.updateMany).toHaveBeenCalledWith({
          where: { id: 't1', used: false },
          data: { used: true },
        });
      });

      it('should revoke every active refresh token of the user', async () => {
        await resetPasswordWithCode(resetInput());

        expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
          where: { userId: USER_ID, revoked: false },
          data: { revoked: true, revokedAt: expect.any(Date) },
        });
      });

      it('should trim whitespace around the code and normalize the email', async () => {
        const user = await resetPasswordWithCode(resetInput({ email: '  Test@Example.com ', code: ` ${CODE} ` }));

        expect(user.id).toBe(USER_ID);
      });
    });
  });

  describe('password reset config', () => {
    it('should not expose the reset token in the default config', () => {
      expect(defaultEnv.auth.exposeResetTokenInResponse).toBe(false);
    });

    it('should not expose the reset token in the staging config', () => {
      expect(stagingEnv.auth.exposeResetTokenInResponse).toBe(false);
    });

    it('should keep staging free of an override that would re-enable exposure after merging with default', () => {
      const merged = { ...defaultEnv.auth, ...stagingEnv.auth };

      expect(merged.exposeResetTokenInResponse).toBe(false);
    });

    it('should expose the reset token only in development and test configs', () => {
      expect(developmentEnv.auth.exposeResetTokenInResponse).toBe(true);
      expect(testEnv.auth.exposeResetTokenInResponse).toBe(true);
    });

    it('should define a non-zero default cooldown and hourly cap', () => {
      expect(defaultEnv.auth.passwordResetCooldownMs).toBeGreaterThan(0);
      expect(defaultEnv.auth.passwordResetMaxPerHour).toBeGreaterThan(0);
    });
  });

  describe('password reset locales', () => {
    const KEYS = Object.values(PasswordResetMessageCode);

    it.each(KEYS)('should translate %s in both locales', (key) => {
      expect(ptBR.errors[key]).toEqual(expect.any(String));
      expect(enUS.errors[key]).toEqual(expect.any(String));
    });

    it('should keep pt-BR accents in the invalid-code message', () => {
      expect(ptBR.errors[PasswordResetMessageCode.INVALID_CODE]).toBe('Código inválido ou expirado. Solicite um novo.');
      expect(ptBR.errors[PasswordResetMessageCode.EMAIL_REQUIRED]).toContain('é');
    });

    it('should translate the invalid-code message to English', () => {
      expect(enUS.errors[PasswordResetMessageCode.INVALID_CODE]).toBe('Invalid or expired code. Request a new one.');
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
