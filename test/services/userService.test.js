import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => {
  return {
    prisma: {
      user: {
        findUnique: vi.fn(),
      },
    },
  };
});

import { prisma } from '../../src/db.js';
import { getUserProfileById } from '../../src/services/user-service.js';

describe('src/services/user-service.js', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws USER_ID_REQUIRED when userId is missing', async () => {
    await expect(getUserProfileById(undefined)).rejects.toMatchObject({
      code: 'USER_ID_REQUIRED',
      statusCode: 400,
    });

    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('throws USER_NOT_FOUND when user does not exist', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(getUserProfileById('u1')).rejects.toMatchObject({
      code: 'USER_NOT_FOUND',
      statusCode: 404,
    });

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'u1' },
      include: {
        address: true,
        socials: true,
      },
    });
  });

  it('returns user profile without passwordHash when found', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      email: 'test@example.com',
      passwordHash: 'secret-hash',
      address: { id: 'a1' },
      socials: { id: 's1' },
    });

    const result = await getUserProfileById('u1');

    expect(result).toEqual({
      id: 'u1',
      email: 'test@example.com',
      address: { id: 'a1' },
      socials: { id: 's1' },
    });

    expect(result.passwordHash).toBeUndefined();
  });
});
