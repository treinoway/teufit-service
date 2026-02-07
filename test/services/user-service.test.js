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
import { getUserProfileById, setActiveProfileToTrainer, updateUserProfile } from '../../src/services/user-service.js';

describe('userService', () => {
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
    gender: true,
    birthDate: true,
    avatarUrl: true,
    address: {
      select: {
        city: true,
        country: true,
        countryCode: true,
        id: true,
        line1: true,
        line2: true,
        neighborhood: true,
        postalCode: true,
        state: true,
        stateCode: true,
      }
    },
    socials: {
      select: {
        id: true,
        instagram: true,
        whatsapp: true,
        x: true,
        threads: true,
        youtube: true,
        linkedin: true,
        facebook: true,
      }
    },
    preferences: {
      select: {
      activeProfile: true,
      rawPreferences: true,
      },
    },
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
    gender: null,
    birthDate: null,
    avatarUrl: null,
    address: { 
      id: 'a1',
      line1: null,
      line2: null,
      neighborhood: null,
      city: null,
      state: null,
      stateCode: null,
      country: null,
      countryCode: null,
      postalCode: null,
    },
    socials: {
      id: 's1',
      instagram: null,
      whatsapp: null,
      x: null,
      threads: null,
      youtube: null,
      linkedin: null,
      facebook: null,
    },
    preferences: {
    activeProfile: 'student',
    rawPreferences: null,
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
    gender: null,
    birthDate: null,
    avatarUrl: null,
    address: { 
      id: 'a1',
      line1: null,
      line2: null,
      neighborhood: null,
      city: null,
      state: null,
      stateCode: null,
      country: null,
      countryCode: null,
      postalCode: null,
    },
    socials: {
      id: 's1',
      instagram: null,
      whatsapp: null,
      x: null,
      threads: null,
      youtube: null,
      linkedin: null,
      facebook: null,
    },
    preferences: {
    activeProfile: 'student',
    rawPreferences: null,
    },
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

  describe('updateUserProfile', () => {
    it('throws USER_ID_REQUIRED when userId is missing', async () => {
      await expect(updateUserProfile(undefined, {})).rejects.toMatchObject({
        code: 'USER_ID_REQUIRED',
        statusCode: 400,
      });

      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('throws USER_NOT_FOUND when user does not exist', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(updateUserProfile('u1', { firstName: 'John' })).rejects.toMatchObject({
        code: 'USER_NOT_FOUND',
        statusCode: 404,
      });

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'u1' },
        select: { id: true },
      });
    });

    it('updates user basic fields successfully', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
      prisma.user.update.mockResolvedValue({
        id: 'u1',
        email: 'test@example.com',
        roles: ['student'],
        status: 'active',
        firstName: 'John',
        lastName: 'Doe',
        gender: 'male',
        birthDate: new Date('1990-05-15'),
        avatarUrl: 'https://example.com/avatar.jpg',
        address: null,
        socials: null,
        preferences: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-28T00:00:00.000Z'),
      });

      const result = await updateUserProfile('u1', {
        firstName: 'John',
        lastName: 'Doe',
        gender: 'male',
        birthDate: '1990-05-15',
        avatarUrl: 'https://example.com/avatar.jpg',
      });

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: {
          firstName: 'John',
          lastName: 'Doe',
          gender: 'male',
          birthDate: new Date('1990-05-15'),
          avatarUrl: 'https://example.com/avatar.jpg',
        },
        select: expect.any(Object),
      });

      expect(result).toMatchObject({
        id: 'u1',
        firstName: 'John',
        lastName: 'Doe',
        avatarUrl: 'https://example.com/avatar.jpg',
      });
    });

    it('upserts address when provided', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
      prisma.user.update.mockResolvedValue({
        id: 'u1',
        email: 'test@example.com',
        roles: ['student'],
        status: 'active',
        firstName: 'John',
        lastName: null,
        gender: null,
        birthDate: null,
        avatarUrl: null,
        address: {
          id: 'a1',
          line1: 'Main St, 123',
          line2: null,
          neighborhood: null,
          city: 'São Paulo',
          state: 'São Paulo',
          stateCode: 'SP',
          country: 'Brasil',
          countryCode: 'BR',
          postalCode: null,
        },
        socials: null,
        preferences: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-28T00:00:00.000Z'),
      });

      const result = await updateUserProfile('u1', {
        firstName: 'John',
        address: {
          line1: 'Main St, 123',
          city: 'São Paulo',
          state: 'São Paulo',
          stateCode: 'SP',
          country: 'Brasil',
          countryCode: 'BR',
        },
      });

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: {
          firstName: 'John',
          address: {
            upsert: {
              create: {
                line1: 'Main St, 123',
                line2: null,
                neighborhood: null,
                city: 'São Paulo',
                state: 'São Paulo',
                stateCode: 'SP',
                country: 'Brasil',
                countryCode: 'BR',
                postalCode: null,
              },
              update: {
                line1: 'Main St, 123',
                city: 'São Paulo',
                state: 'São Paulo',
                stateCode: 'SP',
                country: 'Brasil',
                countryCode: 'BR',
              },
            },
          },
        },
        select: expect.any(Object),
      });

      expect(result.address).toBeDefined();
    });

    it('upserts socials when provided', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
      prisma.user.update.mockResolvedValue({
        id: 'u1',
        email: 'test@example.com',
        roles: ['student'],
        status: 'active',
        firstName: null,
        lastName: null,
        gender: null,
        birthDate: null,
        avatarUrl: null,
        address: null,
        socials: {
          id: 's1',
          instagram: '@johndoe',
          whatsapp: '+5511999999999',
          x: null,
          threads: null,
          youtube: null,
          linkedin: null,
          facebook: null,
        },
        preferences: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-28T00:00:00.000Z'),
      });

      const result = await updateUserProfile('u1', {
        socials: {
          instagram: '@johndoe',
          whatsapp: '+5511999999999',
        },
      });

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: {
          socials: {
            upsert: {
              create: {
                instagram: '@johndoe',
                whatsapp: '+5511999999999',
                x: null,
                threads: null,
                youtube: null,
                linkedin: null,
                facebook: null,
              },
              update: {
                instagram: '@johndoe',
                whatsapp: '+5511999999999',
              },
            },
          },
        },
        select: expect.any(Object),
      });

      expect(result.socials).toBeDefined();
    });

    it('upserts preferences when provided', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
      prisma.user.update.mockResolvedValue({
        id: 'u1',
        email: 'test@example.com',
        roles: ['student'],
        status: 'active',
        firstName: null,
        lastName: null,
        gender: null,
        birthDate: null,
        avatarUrl: null,
        address: null,
        socials: null,
        preferences: {
          activeProfile: 'student',
          rawPreferences: { theme: 'dark', language: 'en' },
        },
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-28T00:00:00.000Z'),
      });

      const result = await updateUserProfile('u1', {
        preferences: {
          rawPreferences: { theme: 'dark', language: 'en' },
        },
      });

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: {
          preferences: {
            upsert: {
              create: {
                rawPreferences: { theme: 'dark', language: 'en' },
              },
              update: {
                rawPreferences: { theme: 'dark', language: 'en' },
              },
            },
          },
        },
        select: expect.any(Object),
      });

      expect(result.preferences).toBeDefined();
      expect(result.preferences.rawPreferences).toEqual({ theme: 'dark', language: 'en' });
    });
  });
});
