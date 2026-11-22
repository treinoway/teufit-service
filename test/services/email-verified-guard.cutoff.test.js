import { describe, it, expect, vi, afterEach } from 'vitest';

import config from '../../config/index.js';
import { AppError } from '../../src/errors/app-error.js';
import { assertEmailVerified, isUserEmailVerified } from '../../src/services/email-verified-guard.js';

const USER_ID = 'user-1';
const VERIFIED_ACCOUNT_ROW = { id: 'account-1' };
const ENFORCED_FROM_ENV = 'EMAIL_VERIFICATION_ENFORCED_FROM';
const OVERRIDDEN_CUTOFF = '2031-02-03T04:05:06.000Z';
const ONE_MS = 1;
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const EMAIL_VERIFICATION_REQUIRED = Object.freeze({
  httpStatus: 403,
  error: 'EMAIL_VERIFICATION_REQUIRED',
  messageCode: 'emailVerification.required',
});

// Instant from which unverified accounts are restricted, read from the configuration under test.
function enforcedFrom() {
  return new Date(config.emailVerification?.enforcedFrom);
}

// Date shifted from the cut-off by the given milliseconds (negative = an account older than the cut-off).
function cutoffPlus(offsetMs) {
  return new Date(enforcedFrom().getTime() + offsetMs);
}

// Prisma double: the user row (or none) and whether the user has a verified account.
function makePrisma({ user, verifiedAccount = null }) {
  return {
    account: { findFirst: vi.fn().mockResolvedValue(verifiedAccount) },
    user: {
      findUnique: vi.fn().mockResolvedValue(user),
      findFirst: vi.fn().mockResolvedValue(user),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  };
}

// Builds a user row created at the given instant.
function userCreatedAt(createdAt) {
  return { id: USER_ID, email: 'pro@example.com', deletedAt: null, createdAt };
}

// Loads a fresh configuration snapshot with the given environment variables.
async function loadConfig(env = {}) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  return (await import('../../config/index.js')).default;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('config.emailVerification.enforcedFrom', () => {
  it('should be a valid instant by default', () => {
    expect(Number.isNaN(enforcedFrom().getTime())).toBe(false);
  });

  it('should not be in the future, so accounts created from now on are restricted', () => {
    expect(enforcedFrom().getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('should take its value from EMAIL_VERIFICATION_ENFORCED_FROM', async () => {
    const fresh = await loadConfig({ [ENFORCED_FROM_ENV]: OVERRIDDEN_CUTOFF });

    expect(new Date(fresh.emailVerification?.enforcedFrom).getTime()).toBe(new Date(OVERRIDDEN_CUTOFF).getTime());
  });
});

describe('assertEmailVerified and the open-signup cut-off', () => {
  describe('when the unverified account was created before the cut-off', () => {
    it.each([
      ['one millisecond before', -ONE_MS],
      ['one year before', -ONE_YEAR_MS],
    ])('should not refuse an account created %s', async (_label, offsetMs) => {
      const prisma = makePrisma({ user: userCreatedAt(cutoffPlus(offsetMs)) });

      await expect(assertEmailVerified(prisma, USER_ID)).resolves.toBeUndefined();
    });

    it('should perform no writes', async () => {
      const prisma = makePrisma({ user: userCreatedAt(cutoffPlus(-ONE_YEAR_MS)) });

      await assertEmailVerified(prisma, USER_ID).catch(() => {});

      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });

    it('should keep reporting the e-mail as unverified through isUserEmailVerified', async () => {
      const prisma = makePrisma({ user: userCreatedAt(cutoffPlus(-ONE_YEAR_MS)) });

      await expect(isUserEmailVerified(prisma, USER_ID)).resolves.toBe(false);
    });
  });

  describe('when the unverified account was created from the cut-off on', () => {
    it.each([
      ['exactly at the cut-off', 0],
      ['one millisecond after', ONE_MS],
      ['one year after', ONE_YEAR_MS],
    ])('should refuse with 403 emailVerification.required an account created %s', async (_label, offsetMs) => {
      const prisma = makePrisma({ user: userCreatedAt(cutoffPlus(offsetMs)) });

      const rejection = await assertEmailVerified(prisma, USER_ID).then(
        () => undefined,
        (error) => error,
      );

      expect(Number.isNaN(enforcedFrom().getTime())).toBe(false);
      expect(rejection).toBeInstanceOf(AppError);
      expect(rejection).toMatchObject(EMAIL_VERIFICATION_REQUIRED);
    });
  });

  describe('when the creation date cannot prove the account is older than the cut-off', () => {
    it.each([
      ['a user row without createdAt', { id: USER_ID, email: 'pro@example.com', deletedAt: null }],
      ['a user row with a null createdAt', userCreatedAt(null)],
      ['no user row', null],
    ])('should refuse with 403 emailVerification.required for %s', async (_label, user) => {
      const prisma = makePrisma({ user });

      await expect(assertEmailVerified(prisma, USER_ID)).rejects.toMatchObject(EMAIL_VERIFICATION_REQUIRED);
    });

    it.each([undefined, null, ''])('should refuse a missing user id %j even when an old user row would match', async (missingUserId) => {
      const prisma = makePrisma({ user: userCreatedAt(cutoffPlus(-ONE_YEAR_MS)) });

      await expect(assertEmailVerified(prisma, missingUserId)).rejects.toMatchObject(EMAIL_VERIFICATION_REQUIRED);
    });
  });

  describe('when the account has a verified e-mail', () => {
    it.each([
      ['before the cut-off', -ONE_YEAR_MS],
      ['after the cut-off', ONE_YEAR_MS],
    ])('should not refuse an account created %s', async (_label, offsetMs) => {
      const prisma = makePrisma({ user: userCreatedAt(cutoffPlus(offsetMs)), verifiedAccount: VERIFIED_ACCOUNT_ROW });

      await expect(assertEmailVerified(prisma, USER_ID)).resolves.toBeUndefined();
    });
  });
});
