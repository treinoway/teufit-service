import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => {
  return {
    prisma: {
      user: {
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      userPreferences: {
        upsert: vi.fn(),
      },
    },
  };
});

import { prisma } from '../../src/db.js';
import { getUserProfileById, setActiveProfileToTrainer } from '../../src/services/user-service.js';

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
    select: {
    id: true,
    email: true,
    roles: true,
    status: true,
    firstName: true,
    lastName: true,
    birthDate: true,
    avatarUrl: true,
    address: true,
    socials: true,
    preferences: {
      select: {
      activeProfile: true,
      createdAt: true,
      updatedAt: true,
      },
    },
    createdAt: true,
    updatedAt: true,
    },
  });
  });

  it('returns user profile without passwordHash when found', async () => {
    prisma.user.findUnique.mockResolvedValue({
    id: 'u1',
    email: 'test@example.com',
    roles: ['student'],
    status: 'pending',
    firstName: null,
    lastName: null,
    birthDate: null,
    avatarUrl: null,
    address: { id: 'a1' },
    socials: { id: 's1' },
    preferences: {
    activeProfile: 'student',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    },
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  });

    const result = await getUserProfileById('u1');

  expect(result).toEqual({
    id: 'u1',
    email: 'test@example.com',
    roles: ['student'],
    status: 'pending',
    firstName: null,
    lastName: null,
    birthDate: null,
    avatarUrl: null,
    address: { id: 'a1' },
    socials: { id: 's1' },
    preferences: {
    activeProfile: 'student',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    },
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  });
  });

  it('setActiveProfileToTrainer throws USER_ID_REQUIRED when userId is missing', async () => {
    await expect(setActiveProfileToTrainer(undefined)).rejects.toMatchObject({
      code: 'USER_ID_REQUIRED',
      statusCode: 400,
    });

    expect(prisma.userPreferences.upsert).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('setActiveProfileToTrainer upserts preferences with trainer profile', async () => {
    prisma.user.findUnique.mockResolvedValue({ roles: ['student'] });
    prisma.userPreferences.upsert.mockResolvedValue({
      id: 'pref1',
      userId: 'u1',
      activeProfile: 'trainer',
    });

    const result = await setActiveProfileToTrainer('u1');

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
    where: { id: 'u1' },
    select: { roles: true },
  });

    expect(prisma.user.update).toHaveBeenCalledWith({
    where: { id: 'u1' },
    data: {
    roles: {
      set: ['student', 'trainer'],
    },
    },
  });

    expect(prisma.userPreferences.upsert).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      create: { userId: 'u1', activeProfile: 'trainer' },
      update: { activeProfile: 'trainer' },
    });

    expect(result).toEqual({
      id: 'pref1',
      userId: 'u1',
      activeProfile: 'trainer',
    });
  });

  it('setActiveProfileToTrainer does not duplicate TRAINER role', async () => {
  prisma.user.findUnique.mockResolvedValue({ roles: ['student', 'trainer'] });
  prisma.userPreferences.upsert.mockResolvedValue({
    id: 'pref2',
    userId: 'u2',
    activeProfile: 'trainer',
  });

  const result = await setActiveProfileToTrainer('u2');

  expect(prisma.user.update).not.toHaveBeenCalled();
  expect(prisma.userPreferences.upsert).toHaveBeenCalledWith({
    where: { userId: 'u2' },
    create: { userId: 'u2', activeProfile: 'trainer' },
    update: { activeProfile: 'trainer' },
  });
  expect(result).toEqual({
    id: 'pref2',
    userId: 'u2',
    activeProfile: 'trainer',
  });
  });
});
