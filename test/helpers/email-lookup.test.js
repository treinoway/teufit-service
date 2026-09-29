import { describe, it, expect, vi, beforeEach } from 'vitest';
import { findUserIdByEmailCaseInsensitive } from '../../src/helpers/email-lookup.js';

describe('findUserIdByEmailCaseInsensitive', () => {
  let prismaClient;

  beforeEach(() => {
    prismaClient = { $queryRaw: vi.fn() };
  });

  describe('short-circuit cases (no query issued)', () => {
    it('returns null and does not query when email is null', async () => {
      const result = await findUserIdByEmailCaseInsensitive(prismaClient, null);

      expect(result).toBeNull();
      expect(prismaClient.$queryRaw).not.toHaveBeenCalled();
    });

    it('returns null and does not query when email is undefined', async () => {
      const result = await findUserIdByEmailCaseInsensitive(prismaClient, undefined);

      expect(result).toBeNull();
      expect(prismaClient.$queryRaw).not.toHaveBeenCalled();
    });

    it('returns null and does not query when email is not a string', async () => {
      const result = await findUserIdByEmailCaseInsensitive(prismaClient, 42);

      expect(result).toBeNull();
      expect(prismaClient.$queryRaw).not.toHaveBeenCalled();
    });

    it('returns null and does not query when email is an empty string', async () => {
      const result = await findUserIdByEmailCaseInsensitive(prismaClient, '');

      expect(result).toBeNull();
      expect(prismaClient.$queryRaw).not.toHaveBeenCalled();
    });

    it('returns null and does not query when email is whitespace-only', async () => {
      const result = await findUserIdByEmailCaseInsensitive(prismaClient, '   ');

      expect(result).toBeNull();
      expect(prismaClient.$queryRaw).not.toHaveBeenCalled();
    });
  });

  describe('querying with a valid email', () => {
    it('trims and lowercases the email before querying', async () => {
      prismaClient.$queryRaw.mockResolvedValue([]);

      await findUserIdByEmailCaseInsensitive(prismaClient, '  TEST@Example.com  ');

      expect(prismaClient.$queryRaw).toHaveBeenCalledTimes(1);
      // $queryRaw is a tagged-template call: (stringsArray, ...interpolatedValues).
      // Assert on the interpolated normalized email value rather than the exact
      // template internals.
      const callArgs = prismaClient.$queryRaw.mock.calls[0];
      expect(callArgs[1]).toBe('test@example.com');
    });

    it('returns the matching row id when $queryRaw resolves a row', async () => {
      prismaClient.$queryRaw.mockResolvedValue([{ id: 'user-123' }]);

      const result = await findUserIdByEmailCaseInsensitive(prismaClient, 'test@example.com');

      expect(result).toBe('user-123');
    });

    it('returns null when $queryRaw resolves an empty array', async () => {
      prismaClient.$queryRaw.mockResolvedValue([]);

      const result = await findUserIdByEmailCaseInsensitive(prismaClient, 'nobody@example.com');

      expect(result).toBeNull();
    });

    it('passes the exact normalized email as the sole interpolated parameter (no wildcard pattern)', async () => {
      prismaClient.$queryRaw.mockResolvedValue([]);

      await findUserIdByEmailCaseInsensitive(prismaClient, 'joao_silva@gmail.com');

      const callArgs = prismaClient.$queryRaw.mock.calls[0];
      // Only strings-array + one interpolated value — proves this is a
      // parameterized exact-match query, not a hand-built ILIKE pattern.
      expect(callArgs).toHaveLength(2);
      expect(callArgs[1]).toBe('joao_silva@gmail.com');
    });
  });
});
