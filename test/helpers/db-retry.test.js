import { describe, it, expect, vi } from 'vitest';
import { withDeadlockRetry } from '../../src/helpers/db-retry.js';
import { AppError } from '../../src/errors/app-error.js';

// Helper — build an error with the given top-level code
function makeCodeError(code, message = 'db error') {
  return Object.assign(new Error(message), { code });
}

// Helper — build an error with code nested under meta
function makeMetaCodeError(code) {
  return Object.assign(new Error('db error'), { meta: { code } });
}

// Helper — build an error with code nested under cause
function makeCauseCodeError(code) {
  return Object.assign(new Error('db error'), { cause: { code } });
}

describe('withDeadlockRetry', () => {
  describe('success path', () => {
    it('returns the result of fn on first successful call', async () => {
      const fn = vi.fn().mockResolvedValue('ok');

      const result = await withDeadlockRetry(fn);

      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledOnce();
    });
  });

  describe('retryable error codes — top-level .code', () => {
    it('retries on P2034 (Prisma write conflict) and returns success after retry', async () => {
      const successValue = { done: true };
      const fn = vi.fn()
        .mockRejectedValueOnce(makeCodeError('P2034'))
        .mockRejectedValueOnce(makeCodeError('P2034'))
        .mockResolvedValueOnce(successValue);

      const result = await withDeadlockRetry(fn, { maxRetries: 3, baseDelayMs: 0 });

      expect(result).toEqual(successValue);
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('retries on 40P01 (Postgres deadlock_detected) and returns success after retry', async () => {
      const successValue = 'deadlock-then-success';
      const fn = vi.fn()
        .mockRejectedValueOnce(makeCodeError('40P01'))
        .mockRejectedValueOnce(makeCodeError('40P01'))
        .mockResolvedValueOnce(successValue);

      const result = await withDeadlockRetry(fn, { maxRetries: 3, baseDelayMs: 0 });

      expect(result).toBe(successValue);
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('retries on 40001 (Postgres serialization_failure) and returns success after retry', async () => {
      const successValue = 'serial-success';
      const fn = vi.fn()
        .mockRejectedValueOnce(makeCodeError('40001'))
        .mockRejectedValueOnce(makeCodeError('40001'))
        .mockResolvedValueOnce(successValue);

      const result = await withDeadlockRetry(fn, { maxRetries: 3, baseDelayMs: 0 });

      expect(result).toBe(successValue);
      expect(fn).toHaveBeenCalledTimes(3);
    });
  });

  describe('retryable error codes — nested locations', () => {
    it('retries when the deadlock code is nested under err.meta.code', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(makeMetaCodeError('P2034'))
        .mockResolvedValueOnce('meta-ok');

      const result = await withDeadlockRetry(fn, { maxRetries: 3, baseDelayMs: 0 });

      expect(result).toBe('meta-ok');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('retries when the deadlock code is nested under err.cause.code', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(makeCauseCodeError('40P01'))
        .mockResolvedValueOnce('cause-ok');

      const result = await withDeadlockRetry(fn, { maxRetries: 3, baseDelayMs: 0 });

      expect(result).toBe('cause-ok');
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe('retryable error messages — substring match', () => {
    it('retries when the error message contains "deadlock detected"', async () => {
      const deadlockErr = new Error('ERROR: deadlock detected — try again');
      const fn = vi.fn()
        .mockRejectedValueOnce(deadlockErr)
        .mockResolvedValueOnce('message-ok');

      const result = await withDeadlockRetry(fn, { maxRetries: 3, baseDelayMs: 0 });

      expect(result).toBe('message-ok');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('retries when the error message contains "could not serialize"', async () => {
      const serializeErr = new Error('could not serialize access due to concurrent update');
      const fn = vi.fn()
        .mockRejectedValueOnce(serializeErr)
        .mockResolvedValueOnce('serialize-ok');

      const result = await withDeadlockRetry(fn, { maxRetries: 3, baseDelayMs: 0 });

      expect(result).toBe('serialize-ok');
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe('retry exhaustion', () => {
    it('gives up after maxRetries (default 3) and rethrows the last error', async () => {
      const err = makeCodeError('P2034');
      const fn = vi.fn().mockRejectedValue(err);

      await expect(
        withDeadlockRetry(fn, { maxRetries: 3, baseDelayMs: 0 }),
      ).rejects.toBe(err);

      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('respects custom maxRetries — gives up after 2 attempts when maxRetries is 2', async () => {
      const err = makeCodeError('40P01');
      const fn = vi.fn().mockRejectedValue(err);

      await expect(
        withDeadlockRetry(fn, { maxRetries: 2, baseDelayMs: 0 }),
      ).rejects.toBe(err);

      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe('non-retryable errors', () => {
    it('does NOT retry an AppError and rethrows it immediately', async () => {
      const appErr = new AppError({
        httpStatus: 404,
        error: 'EXERCISE_NOT_FOUND',
        messageCode: 'exercise.notFound',
        message: 'Exercise not found',
      });
      const fn = vi.fn().mockRejectedValue(appErr);

      await expect(
        withDeadlockRetry(fn, { maxRetries: 3, baseDelayMs: 0 }),
      ).rejects.toBe(appErr);

      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry a generic Error without a deadlock signature', async () => {
      const genericErr = new Error('some db constraint violation');
      const fn = vi.fn().mockRejectedValue(genericErr);

      await expect(
        withDeadlockRetry(fn, { maxRetries: 3, baseDelayMs: 0 }),
      ).rejects.toBe(genericErr);

      expect(fn).toHaveBeenCalledTimes(1);
    });
  });
});
