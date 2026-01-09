import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Prisma client used by trainerService
vi.mock('../../src/db.js', () => {
  return {
    prisma: {
      $transaction: vi.fn(),
    },
  };
});

import { prisma } from '../../src/db.js';
import { updateMyTrainerProfile } from '../../src/services/trainerService.js';

describe('src/services/trainerService.js', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
          update: vi.fn().mockResolvedValue({ id: 't1', userId: 'u1', firstName: 'Ana' }),
        },
        address: {
          upsert: vi.fn().mockResolvedValue({ id: 'a1', userId: 'u1' }),
        },
        socialNetwork: {
          upsert: vi.fn().mockResolvedValue({ id: 's1', userId: 'u1' }),
        },
        user: {
          update: vi.fn().mockResolvedValue({ id: 'u1', status: 'active' }),
        },
      };

      const res = await fn(tx);

      // quick assertions inside fake tx call
      expect(tx.trainer.findUnique).toHaveBeenCalledWith({ where: { userId: 'u1' } });
      expect(tx.trainer.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 't1' },
          data: expect.objectContaining({ firstName: 'Ana' }),
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
      expect(tx.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { status: 'active' } });

      return res;
    });

    const res = await updateMyTrainerProfile({
      userId: 'u1',
      trainer: { firstName: 'Ana' },
      address: {
        street: 'Main',
        houseNumber: '1',
        city: 'NY',
        country: 'US',
      },
      socials: {
        instagram: '@ana',
      },
    });

    expect(res).toEqual({
      id: 't1',
      firstName: 'Ana',
      address: { id: 'a1', userId: 'u1' },
      socialNetworks: { id: 's1', userId: 'u1' },
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
