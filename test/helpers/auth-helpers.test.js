import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Prisma before importing the helpers under test.
vi.mock('../../src/db.js', () => {
  return {
    prisma: {
      account: {
        findUnique: vi.fn(),
      },
      user: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
      },
      $queryRaw: vi.fn(),
    },
  };
});

import { prisma } from '../../src/db.js';
import {
  findAccountByProvider,
  findUserByEmailInsensitive,
} from '../../src/helpers/auth.js';

describe('findAccountByProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return null when provider is falsy', async () => {
    const result = await findAccountByProvider(null, 'some-provider-id');
    expect(result).toBeNull();
    expect(prisma.account.findUnique).not.toHaveBeenCalled();
  });

  it('should return null when providerId is falsy', async () => {
    const result = await findAccountByProvider('apple', null);
    expect(result).toBeNull();
    expect(prisma.account.findUnique).not.toHaveBeenCalled();
  });

  it('should return null when both provider and providerId are falsy', async () => {
    const result = await findAccountByProvider(undefined, undefined);
    expect(result).toBeNull();
    expect(prisma.account.findUnique).not.toHaveBeenCalled();
  });

  it('should call prisma.account.findUnique with composite key when both args are present', async () => {
    const mockAccount = { id: 'acc-1', provider: 'apple', providerId: 'apple-sub-001' };
    prisma.account.findUnique.mockResolvedValue(mockAccount);

    const result = await findAccountByProvider('apple', 'apple-sub-001');

    expect(prisma.account.findUnique).toHaveBeenCalledWith({
      where: { provider_providerId: { provider: 'apple', providerId: 'apple-sub-001' } },
    });
    expect(result).toEqual(mockAccount);
  });

  it('should return null when account does not exist in DB', async () => {
    prisma.account.findUnique.mockResolvedValue(null);

    const result = await findAccountByProvider('apple', 'nonexistent-sub');

    expect(result).toBeNull();
  });

  it('should work for any provider string (not just apple)', async () => {
    const mockAccount = { id: 'acc-2', provider: 'google', providerId: 'google-uid-999' };
    prisma.account.findUnique.mockResolvedValue(mockAccount);

    const result = await findAccountByProvider('google', 'google-uid-999');

    expect(prisma.account.findUnique).toHaveBeenCalledWith({
      where: { provider_providerId: { provider: 'google', providerId: 'google-uid-999' } },
    });
    expect(result).toEqual(mockAccount);
  });
});

describe('findUserByEmailInsensitive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return null when email is null', async () => {
    const result = await findUserByEmailInsensitive(null);
    expect(result).toBeNull();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('should return null when email is undefined', async () => {
    const result = await findUserByEmailInsensitive(undefined);
    expect(result).toBeNull();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('should return null when email is not a string', async () => {
    const result = await findUserByEmailInsensitive(42);
    expect(result).toBeNull();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('should return null when email is empty string', async () => {
    const result = await findUserByEmailInsensitive('');
    expect(result).toBeNull();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('should look up the id via $queryRaw with the normalized email, then fetch the full user by id', async () => {
    const mockUser = { id: 'user-1', email: 'test@example.com' };
    prisma.$queryRaw.mockResolvedValue([{ id: 'user-1' }]);
    prisma.user.findUnique.mockResolvedValue(mockUser);

    const result = await findUserByEmailInsensitive('TEST@EXAMPLE.COM');

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw.mock.calls[0][1]).toBe('test@example.com');
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 'user-1' } });
    expect(result).toEqual(mockUser);
  });

  it('should trim whitespace from email before querying', async () => {
    const mockUser = { id: 'user-2', email: 'trimmed@example.com' };
    prisma.$queryRaw.mockResolvedValue([{ id: 'user-2' }]);
    prisma.user.findUnique.mockResolvedValue(mockUser);

    await findUserByEmailInsensitive('  trimmed@example.com  ');

    expect(prisma.$queryRaw.mock.calls[0][1]).toBe('trimmed@example.com');
  });

  it('should still normalize (lowercase) a mixed-case stored-legacy-style email before querying', async () => {
    prisma.$queryRaw.mockResolvedValue([{ id: 'user-3' }]);
    prisma.user.findUnique.mockResolvedValue({ id: 'user-3', email: 'mixedcase@example.com' });

    await findUserByEmailInsensitive('MixedCase@Example.com');

    expect(prisma.$queryRaw.mock.calls[0][1]).toBe('mixedcase@example.com');
  });

  it('should pass the email as an exact parameterized value, not a wildcard pattern, so "_" is not treated as a wildcard', async () => {
    prisma.$queryRaw.mockResolvedValue([]);

    await findUserByEmailInsensitive('joao_silva@gmail.com');

    const callArgs = prisma.$queryRaw.mock.calls[0];
    expect(callArgs[1]).toBe('joao_silva@gmail.com');
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('should return null when no row matches, without calling findUnique', async () => {
    prisma.$queryRaw.mockResolvedValue([]);

    const result = await findUserByEmailInsensitive('nobody@example.com');

    expect(result).toBeNull();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});
