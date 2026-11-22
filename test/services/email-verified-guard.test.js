import { describe, it, expect, vi, beforeEach } from 'vitest';

import { AppError } from '../../src/errors/app-error.js';
import { EmailVerificationErrorCode, EmailVerificationMessageCode } from '../../src/constants/email-verification.js';
import * as emailVerifiedGuard from '../../src/services/email-verified-guard.js';

const { isUserEmailVerified, assertEmailVerified } = emailVerifiedGuard;

const USER_ID = 'user-1';
const VERIFIED_ACCOUNT_ROW = { id: 'account-1' };
const FORBIDDEN_STATUS = 403;
const PRISMA_WRITE_METHODS = ['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany'];
const MISSING_USER_IDS = [undefined, null, ''];

// Prisma double: the account lookup answers the given row (null = no verified account, or no account at all); the user row has no creation date, so the open-signup cut-off never exempts it (the cut-off has its own test file).
function makePrisma(verifiedAccount) {
  const account = { findFirst: vi.fn().mockResolvedValue(verifiedAccount) };
  for (const method of PRISMA_WRITE_METHODS) account[method] = vi.fn();
  const user = { findUnique: vi.fn().mockResolvedValue({ id: USER_ID }), update: vi.fn(), updateMany: vi.fn() };
  return { account, user, $transaction: vi.fn() };
}

// Counts every write the guard made through the Prisma double.
function countWrites(prisma) {
  const accountWrites = PRISMA_WRITE_METHODS.reduce((total, method) => total + prisma.account[method].mock.calls.length, 0);
  return (
    accountWrites +
    prisma.user.update.mock.calls.length +
    prisma.user.updateMany.mock.calls.length +
    prisma.$transaction.mock.calls.length
  );
}

// Runs the guard and returns the error it rejected with (undefined when it resolved).
async function captureRejection(prisma, userId) {
  return assertEmailVerified(prisma, userId).then(
    () => undefined,
    (error) => error,
  );
}

describe('email-verified-guard exports', () => {
  it('should export only isUserEmailVerified and assertEmailVerified', () => {
    expect(Object.keys(emailVerifiedGuard).sort()).toEqual(['assertEmailVerified', 'isUserEmailVerified']);
  });
});

describe('isUserEmailVerified', () => {
  describe('when one of the user accounts has verifiedAt set', () => {
    let prisma;

    beforeEach(() => {
      prisma = makePrisma(VERIFIED_ACCOUNT_ROW);
    });

    it('should return true', async () => {
      await expect(isUserEmailVerified(prisma, USER_ID)).resolves.toBe(true);
    });

    it('should look for any account of the user with a non-null verifiedAt, regardless of provider', async () => {
      await isUserEmailVerified(prisma, USER_ID);

      expect(prisma.account.findFirst).toHaveBeenCalledTimes(1);
      expect(prisma.account.findFirst).toHaveBeenCalledWith({
        where: { userId: USER_ID, verifiedAt: { not: null } },
        select: { id: true },
      });
    });

    it('should perform no writes', async () => {
      await isUserEmailVerified(prisma, USER_ID);

      expect(countWrites(prisma)).toBe(0);
    });
  });

  describe('when no account of the user has verifiedAt set, or the user has no account', () => {
    let prisma;

    beforeEach(() => {
      prisma = makePrisma(null);
    });

    it('should return false', async () => {
      await expect(isUserEmailVerified(prisma, USER_ID)).resolves.toBe(false);
    });

    it('should issue the same single read and no writes', async () => {
      await isUserEmailVerified(prisma, USER_ID);

      expect(prisma.account.findFirst).toHaveBeenCalledTimes(1);
      expect(countWrites(prisma)).toBe(0);
    });
  });

  describe('when the user id is missing', () => {
    it.each(MISSING_USER_IDS)('should answer false for user id %j even when some verified account exists', async (missingUserId) => {
      const prisma = makePrisma(VERIFIED_ACCOUNT_ROW);

      await expect(isUserEmailVerified(prisma, missingUserId)).resolves.toBe(false);
    });

    it.each(MISSING_USER_IDS)('should not query the database for user id %j', async (missingUserId) => {
      const prisma = makePrisma(VERIFIED_ACCOUNT_ROW);

      await isUserEmailVerified(prisma, missingUserId);

      expect(prisma.account.findFirst).not.toHaveBeenCalled();
    });
  });

  it('should propagate a database failure instead of answering', async () => {
    const prisma = makePrisma(null);
    const databaseFailure = new AppError({ httpStatus: 500, error: 'DB_DOWN', messageCode: 'db.down', message: 'down' });
    prisma.account.findFirst.mockRejectedValue(databaseFailure);

    await expect(isUserEmailVerified(prisma, USER_ID)).rejects.toBe(databaseFailure);
  });
});

describe('assertEmailVerified', () => {
  describe('when the user has a verified account', () => {
    let prisma;

    beforeEach(() => {
      prisma = makePrisma(VERIFIED_ACCOUNT_ROW);
    });

    it('should resolve without a value', async () => {
      await expect(assertEmailVerified(prisma, USER_ID)).resolves.toBeUndefined();
    });

    it('should read the verified account of that user once and perform no writes', async () => {
      await assertEmailVerified(prisma, USER_ID);

      expect(prisma.account.findFirst).toHaveBeenCalledTimes(1);
      expect(prisma.account.findFirst).toHaveBeenCalledWith({
        where: { userId: USER_ID, verifiedAt: { not: null } },
        select: { id: true },
      });
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(countWrites(prisma)).toBe(0);
    });
  });

  describe('when the user has no verified account', () => {
    let prisma;

    beforeEach(() => {
      prisma = makePrisma(null);
    });

    it('should reject with an AppError', async () => {
      await expect(captureRejection(prisma, USER_ID)).resolves.toBeInstanceOf(AppError);
    });

    it('should reject with HTTP 403', async () => {
      const error = await captureRejection(prisma, USER_ID);

      expect(error.httpStatus).toBe(FORBIDDEN_STATUS);
    });

    it('should reject with the EMAIL_VERIFICATION_REQUIRED error and emailVerification.required messageCode', async () => {
      const error = await captureRejection(prisma, USER_ID);

      expect(error).toMatchObject({
        error: EmailVerificationErrorCode.REQUIRED,
        messageCode: EmailVerificationMessageCode.REQUIRED,
      });
      expect(error.message).toEqual(expect.any(String));
      expect(error.message).not.toHaveLength(0);
    });

    it('should keep the stable contract values clients match on', () => {
      expect(EmailVerificationErrorCode.REQUIRED).toBe('EMAIL_VERIFICATION_REQUIRED');
      expect(EmailVerificationMessageCode.REQUIRED).toBe('emailVerification.required');
    });

    it('should read only the creation date of that user to apply the open-signup cut-off', async () => {
      await captureRejection(prisma, USER_ID);

      expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: USER_ID }, select: { createdAt: true } });
    });

    it('should perform no writes', async () => {
      await captureRejection(prisma, USER_ID);

      expect(countWrites(prisma)).toBe(0);
    });
  });

  describe('when the user id is missing', () => {
    it.each(MISSING_USER_IDS)('should reject with 403 emailVerification.required for user id %j', async (missingUserId) => {
      const prisma = makePrisma(VERIFIED_ACCOUNT_ROW);

      const error = await captureRejection(prisma, missingUserId);

      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({
        httpStatus: FORBIDDEN_STATUS,
        error: EmailVerificationErrorCode.REQUIRED,
        messageCode: EmailVerificationMessageCode.REQUIRED,
      });
    });

    it.each(MISSING_USER_IDS)('should not query the database for user id %j', async (missingUserId) => {
      const prisma = makePrisma(VERIFIED_ACCOUNT_ROW);

      await captureRejection(prisma, missingUserId);

      expect(prisma.account.findFirst).not.toHaveBeenCalled();
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });
  });

  it('should propagate a database failure instead of masking it as unverified', async () => {
    const prisma = makePrisma(null);
    const databaseFailure = new AppError({ httpStatus: 500, error: 'DB_DOWN', messageCode: 'db.down', message: 'down' });
    prisma.account.findFirst.mockRejectedValue(databaseFailure);

    await expect(assertEmailVerified(prisma, USER_ID)).rejects.toBe(databaseFailure);
  });
});
