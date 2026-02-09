import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Prisma client used by trainerService
vi.mock('../../src/db.js', () => {
  return {
    prisma: {
      $transaction: vi.fn(),
    },
  };
});

vi.mock('../../src/config/s3-bucket-handler.js', () => ({
  default: {
    resolveUrl: vi.fn(),
  },
}));

import { prisma } from '../../src/db.js';
import s3BucketHandler from '../../src/config/s3-bucket-handler.js';
import { updateMyTrainerProfile } from '../../src/services/trainer-service.js';

describe('trainerService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    s3BucketHandler.resolveUrl.mockResolvedValue(null);
  });

  it('throws NO_UPDATES when nothing is provided', async () => {
    await expect(updateMyTrainerProfile({ userId: 'u1' })).rejects.toMatchObject({
      code: 'NO_UPDATES',
      statusCode: 400,
    });

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('throws TRAINER_PROFILE_MISSING when trainer row does not exist', async () => {
    prisma.$transaction.mockImplementation(async (fn) => {
      const tx = {
        trainer: { findUnique: vi.fn().mockResolvedValue(null) },
      };
      return fn(tx);
    });

    await expect(
      updateMyTrainerProfile({
        userId: 'u1',
        trainer: { firstName: 'A' },
      }),
    ).rejects.toMatchObject({
      code: 'TRAINER_PROFILE_MISSING',
      statusCode: 409,
    });
  });

  it('updates trainer, upserts address + socials, and activates user', async () => {
    prisma.$transaction.mockImplementation(async (fn) => {
      const tx = {
        trainer: {
          findUnique: vi.fn().mockResolvedValue({ id: 't1', userId: 'u1' }),
          update: vi.fn().mockResolvedValue({ id: 't1', userId: 'u1', professionalDocument: 'ABC' }),
        },
        address: {
          upsert: vi.fn().mockResolvedValue({ id: 'a1', userId: 'u1' }),
        },
        socialNetwork: {
          upsert: vi.fn().mockResolvedValue({ id: 's1', userId: 'u1' }),
        },
        user: {
          update: vi.fn().mockResolvedValue({ id: 'u1', status: 'active', firstName: 'Ana' }),
        },
      };

      const res = await fn(tx);

      // quick assertions inside fake tx call
      expect(tx.trainer.findUnique).toHaveBeenCalledWith({ where: { userId: 'u1' } });
      expect(tx.trainer.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 't1' },
          data: expect.objectContaining({ professionalDocument: 'ABC' }),
        }),
      );
      expect(tx.address.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'u1' },
          create: expect.objectContaining({ userId: 'u1' }),
          update: expect.any(Object),
        }),
      );
      expect(tx.socialNetwork.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'u1' },
          create: expect.objectContaining({ userId: 'u1' }),
          update: expect.any(Object),
        }),
      );
      expect(tx.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: expect.objectContaining({ status: 'active' }),
      });

      return res;
    });

    const res = await updateMyTrainerProfile({
      userId: 'u1',
      trainer: { firstName: 'Ana', professionalDocument: 'ABC' },
      address: {
        line1: 'Main St',
        city: 'NY',
        country: 'US',
      },
      socials: {
        instagram: '@ana',
      },
    });

    expect(res).toEqual({
      id: 't1',
      professionalDocument: 'ABC',
      firstName: 'Ana',
      lastName: undefined,
      birthDate: undefined,
      avatarUrl: null,
      address: { id: 'a1', userId: 'u1' },
      socialNetworks: { id: 's1', userId: 'u1' },
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('validates serviceMode contains only valid values', async () => {
    prisma.$transaction.mockImplementation(async (fn) => {
      const tx = {
        trainer: {
          findUnique: vi.fn().mockResolvedValue({ id: 't1', userId: 'u1' }),
        },
      };
      return fn(tx);
    });

    await expect(
      updateMyTrainerProfile({
        userId: 'u1',
        trainer: { serviceMode: 'invalid' },
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_SERVICE_MODE',
      statusCode: 400,
    });
  });

  it('accepts valid serviceMode', async () => {
    prisma.$transaction.mockImplementation(async (fn) => {
      const tx = {
        trainer: {
          findUnique: vi.fn().mockResolvedValue({ id: 't1', userId: 'u1' }),
          update: vi.fn().mockResolvedValue({ id: 't1', userId: 'u1', serviceMode: 'online' }),
        },
        user: {
          update: vi.fn().mockResolvedValue({ id: 'u1', status: 'active', firstName: 'Ana' }),
        },
      };
      return fn(tx);
    });

    const res = await updateMyTrainerProfile({
      userId: 'u1',
      trainer: { serviceMode: 'online', firstName: 'Ana' },
    });

    expect(res).toEqual({
      id: 't1',
      serviceMode: 'online',
      firstName: 'Ana',
      lastName: undefined,
      birthDate: undefined,
      avatarUrl: null,
      address: null,
      socialNetworks: null,
    });
  });
});
