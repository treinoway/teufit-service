import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  issueAccessToken,
  rotateRefreshToken,
  revokeAllUserRefreshTokens
} from '../../src/services/token-service.js';

// Mock Prisma
vi.mock('../../src/db.js', () => ({
  prisma: {
    refreshToken: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    device: {
      deleteMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

import { prisma } from '../../src/db.js';

describe('tokenService', () => {
  it('issues a Bearer token with expiresIn', () => {
    const fastify = {
      jwt: {
        sign: (payload, opts) => {
          // minimal sanity checks
          if (!payload?.sub) throw new Error('missing sub');
          if (!opts?.expiresIn) throw new Error('missing expiresIn');
          return 'signed.jwt.token';
        },
      },
    };

    const user = { id: 'u1', email: 'a@b.com', roles: ['trainer'], status: 'pending' };
    const res = issueAccessToken({ fastify, user, expiresInSeconds: 60 });

    expect(res).toEqual({
      accessToken: 'signed.jwt.token',
      tokenType: 'Bearer',
      expiresIn: 60,
    });
  });

  describe('rotateRefreshToken', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('successfully rotates a valid token', async () => {
      const mockUser = {
        id: 'user123',
        email: 'test@example.com',
        roles: ['student'],
        status: 'active',
        deletedAt: null
      };

      const mockStoredToken = {
        id: 'token123',
        tokenHash: expect.any(String),
        userId: 'user123',
        revoked: false,
        revokedAt: null,
        expiresAt: new Date(Date.now() + 86400000), // 1 day in future
        createdAt: new Date(),
        rotatedAt: null,
        user: mockUser
      };

      // Mock findUnique to return valid token
      prisma.refreshToken.findUnique.mockResolvedValue(mockStoredToken);

      // Mock update for revocation
      prisma.refreshToken.update.mockResolvedValue({
        ...mockStoredToken,
        revoked: true,
        revokedAt: new Date(),
        rotatedAt: new Date()
      });

      // Mock create for new token
      prisma.refreshToken.create.mockResolvedValue({
        id: 'newToken123',
        tokenHash: expect.any(String),
        userId: 'user123',
        revoked: false,
        expiresAt: new Date(Date.now() + 604800000), // 7 days
        createdAt: new Date()
      });

      const result = await rotateRefreshToken('old-token-string');

      expect(result).toHaveProperty('refreshToken');
      expect(result).toHaveProperty('user');
      expect(result.user.id).toBe('user123');
      expect(typeof result.refreshToken).toBe('string');

      // Verify old token was revoked with rotatedAt
      expect(prisma.refreshToken.update).toHaveBeenCalledWith({
        where: { tokenHash: expect.any(String) },
        data: {
          revoked: true,
          revokedAt: expect.any(Date),
          rotatedAt: expect.any(Date)
        }
      });

      // Verify new token was created
      expect(prisma.refreshToken.create).toHaveBeenCalled();
    });

    it('rejects invalid token with INVALID_REFRESH_TOKEN error', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(null);

      await expect(rotateRefreshToken('invalid-token')).rejects.toThrow('Invalid refresh token');
      await expect(rotateRefreshToken('invalid-token')).rejects.toMatchObject({
        code: 'INVALID_REFRESH_TOKEN'
      });
    });

    it('rejects revoked token with REFRESH_TOKEN_REVOKED error', async () => {
      const mockRevokedToken = {
        id: 'token123',
        revoked: true,
        revokedAt: new Date(Date.now() - 3600000),
        expiresAt: new Date(Date.now() + 86400000),
        user: { id: 'user123', deletedAt: null }
      };

      prisma.refreshToken.findUnique.mockResolvedValue(mockRevokedToken);

      await expect(rotateRefreshToken('revoked-token')).rejects.toThrow('Refresh token has been revoked');
      await expect(rotateRefreshToken('revoked-token')).rejects.toMatchObject({
        code: 'REFRESH_TOKEN_REVOKED'
      });
    });

    it('rejects expired token with REFRESH_TOKEN_EXPIRED error', async () => {
      const mockExpiredToken = {
        id: 'token123',
        revoked: false,
        expiresAt: new Date(Date.now() - 3600000), // 1 hour ago
        user: { id: 'user123', deletedAt: null }
      };

      prisma.refreshToken.findUnique.mockResolvedValue(mockExpiredToken);

      await expect(rotateRefreshToken('expired-token')).rejects.toThrow('Refresh token expired');
      await expect(rotateRefreshToken('expired-token')).rejects.toMatchObject({
        code: 'REFRESH_TOKEN_EXPIRED'
      });
    });

    it('rejects token for deleted user with USER_DELETED error', async () => {
      const mockTokenWithDeletedUser = {
        id: 'token123',
        revoked: false,
        expiresAt: new Date(Date.now() + 86400000),
        user: {
          id: 'user123',
          deletedAt: new Date(Date.now() - 3600000) // User deleted 1 hour ago
        }
      };

      prisma.refreshToken.findUnique.mockResolvedValue(mockTokenWithDeletedUser);

      await expect(rotateRefreshToken('token-for-deleted-user')).rejects.toThrow('User account deactivated');
      await expect(rotateRefreshToken('token-for-deleted-user')).rejects.toMatchObject({
        code: 'USER_DELETED'
      });
    });

    it('marks old token with rotatedAt timestamp', async () => {
      const mockUser = {
        id: 'user123',
        email: 'test@example.com',
        roles: ['student'],
        status: 'active',
        deletedAt: null
      };

      const mockStoredToken = {
        id: 'token123',
        revoked: false,
        expiresAt: new Date(Date.now() + 86400000),
        user: mockUser
      };

      prisma.refreshToken.findUnique.mockResolvedValue(mockStoredToken);
      prisma.refreshToken.update.mockResolvedValue({});
      prisma.refreshToken.create.mockResolvedValue({
        id: 'newToken',
        tokenHash: 'hash',
        expiresAt: new Date()
      });

      await rotateRefreshToken('some-token');

      // Verify rotatedAt is set when revoking
      const updateCall = prisma.refreshToken.update.mock.calls[0][0];
      expect(updateCall.data).toHaveProperty('rotatedAt');
      expect(updateCall.data.rotatedAt).toBeInstanceOf(Date);
      expect(updateCall.data.revoked).toBe(true);
      expect(updateCall.data.revokedAt).toBeInstanceOf(Date);
    });
  });
});

describe('revokeAllUserRefreshTokens', () => {
  const USER_ID = 'user-revoke-1';

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.refreshToken.updateMany.mockReturnValue('revoke-op');
    prisma.device.deleteMany.mockReturnValue('delete-devices-op');
    prisma.$transaction.mockResolvedValue([]);
  });

  it('should revoke the live refresh tokens and delete the user devices in one transaction', async () => {
    await revokeAllUserRefreshTokens(USER_ID);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledWith(['revoke-op', 'delete-devices-op']);
  });

  it('should delete only the devices of the given user', async () => {
    await revokeAllUserRefreshTokens(USER_ID);

    expect(prisma.device.deleteMany).toHaveBeenCalledWith({ where: { userId: USER_ID } });
  });

  it('should only revoke tokens of the user that are not revoked yet', async () => {
    await revokeAllUserRefreshTokens(USER_ID);

    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, revoked: false },
      data: { revoked: true, revokedAt: expect.any(Date) },
    });
  });
});
