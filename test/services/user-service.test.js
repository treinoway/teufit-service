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
      trainer: {
        findFirst: vi.fn(),
        create: vi.fn(),
      },
      trainerStudent: {
        findFirst: vi.fn(),
      },
    },
  };
});

vi.mock('../../src/services/address-service.js', () => ({
  getAddressByPostalCode: vi.fn(),
}));

import { prisma } from '../../src/db.js';
import { getAddressByPostalCode } from '../../src/services/address-service.js';
import { getUserProfileById, setActiveProfileToTrainer, updateUserProfile } from '../../src/services/user-service.js';

describe('userService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no active trainer link — individual tests override when needed
    prisma.trainerStudent.findFirst.mockResolvedValue(null);
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

    expect(prisma.user.findUnique).toHaveBeenCalled();
  });

  it('returns user profile without passwordHash when found with all relations', async () => {
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

    const result = await getUserProfileById('u1', ['address', 'socials', 'preferences']);

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
    hasActiveTrainer: false,
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

      expect(prisma.user.update).toHaveBeenCalledTimes(1);
      const [updateArgs] = prisma.user.update.mock.calls[0];

      expect(updateArgs.where).toEqual({ id: 'u1' });
      expect(updateArgs.data).toEqual({
        firstName: 'John',
        lastName: 'Doe',
        gender: 'male',
        birthDate: new Date(Date.UTC(1990, 4, 15, 12, 0, 0)),
        avatarUrl: 'https://example.com/avatar.jpg',
      });
      expect(updateArgs.select).toEqual(expect.any(Object));

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

    describe('CEP validation', () => {
      it('skips CEP validation when postalCode is not provided in address', async () => {
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
          address: { id: 'a1', line1: 'Main St', line2: null, neighborhood: null, city: null, state: null, stateCode: null, country: null, countryCode: null, postalCode: null },
          socials: null,
          preferences: null,
        });

        await updateUserProfile('u1', { address: { line1: 'Main St' } });

        expect(getAddressByPostalCode).not.toHaveBeenCalled();
      });

      it('skips CEP validation when address is not provided', async () => {
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
          address: null,
          socials: null,
          preferences: null,
        });

        await updateUserProfile('u1', { firstName: 'John' });

        expect(getAddressByPostalCode).not.toHaveBeenCalled();
      });

      it('validates CEP when postalCode is provided and calls getAddressByPostalCode', async () => {
        prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
        getAddressByPostalCode.mockResolvedValue({ postalCode: '01310-100', city: 'São Paulo' });
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
          address: { id: 'a1', line1: null, line2: null, neighborhood: null, city: null, state: null, stateCode: null, country: null, countryCode: null, postalCode: '01310-100' },
          socials: null,
          preferences: null,
        });

        await updateUserProfile('u1', { address: { postalCode: '01310-100' } });

        expect(getAddressByPostalCode).toHaveBeenCalledWith('01310-100');
      });

      it('throws INVALID_POSTAL_CODE_FORMAT when postalCode has invalid format', async () => {
        prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
        const err = new Error('Invalid postal code format. Brazilian postal codes must have 8 digits');
        err.code = 'INVALID_POSTAL_CODE_FORMAT';
        err.statusCode = 400;
        getAddressByPostalCode.mockRejectedValue(err);

        await expect(updateUserProfile('u1', { address: { postalCode: '123' } })).rejects.toMatchObject({
          code: 'INVALID_POSTAL_CODE_FORMAT',
          statusCode: 400,
        });

        expect(prisma.user.update).not.toHaveBeenCalled();
      });

      it('throws POSTAL_CODE_NOT_FOUND when CEP does not exist', async () => {
        prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
        const err = new Error('Postal code not found');
        err.code = 'POSTAL_CODE_NOT_FOUND';
        err.statusCode = 404;
        getAddressByPostalCode.mockRejectedValue(err);

        await expect(updateUserProfile('u1', { address: { postalCode: '99999-999' } })).rejects.toMatchObject({
          code: 'POSTAL_CODE_NOT_FOUND',
          statusCode: 404,
        });

        expect(prisma.user.update).not.toHaveBeenCalled();
      });

      it('throws POSTAL_CODE_API_ERROR when ViaCEP is unavailable', async () => {
        prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
        const err = new Error('Failed to fetch postal code information');
        err.code = 'POSTAL_CODE_API_ERROR';
        err.statusCode = 502;
        getAddressByPostalCode.mockRejectedValue(err);

        await expect(updateUserProfile('u1', { address: { postalCode: '01310-100' } })).rejects.toMatchObject({
          code: 'POSTAL_CODE_API_ERROR',
          statusCode: 502,
        });

        expect(prisma.user.update).not.toHaveBeenCalled();
      });
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

  describe('getUserProfileById with lazy loading', () => {
    it('returns minimal payload when no relations are requested', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: 'test@example.com',
        roles: ['student'],
        status: 'active',
        firstName: 'John',
        lastName: 'Doe',
        gender: 'male',
        birthDate: new Date('1990-01-01'),
        avatarUrl: 'https://example.com/avatar.jpg',
      });

      const result = await getUserProfileById('u1', []);

      expect(result).toEqual({
        id: 'u1',
        email: 'test@example.com',
        roles: ['student'],
        status: 'active',
        firstName: 'John',
        lastName: 'Doe',
        gender: 'male',
        birthDate: '1990-01-01',
        avatarUrl: 'https://example.com/avatar.jpg',
        hasActiveTrainer: false,
      });
      expect(result).not.toHaveProperty('address');
      expect(result).not.toHaveProperty('socials');
      expect(result).not.toHaveProperty('preferences');
    });

    it('returns only address when only address is requested', async () => {
      prisma.user.findUnique.mockResolvedValue({
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
          line1: '123 Main St',
          line2: null,
          neighborhood: null,
          city: 'São Paulo',
          state: 'São Paulo',
          stateCode: 'SP',
          country: 'Brasil',
          countryCode: 'BR',
          postalCode: '01000-000',
        },
      });

      const result = await getUserProfileById('u1', ['address']);

      expect(result).toHaveProperty('address');
      expect(result.address).toMatchObject({
        id: 'a1',
        line1: '123 Main St',
        city: 'São Paulo',
        postalCode: '01000-000',
      });
      expect(result).not.toHaveProperty('socials');
      expect(result).not.toHaveProperty('preferences');
    });

    it('returns only socials when only socials is requested', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: 'test@example.com',
        roles: ['student'],
        status: 'active',
        firstName: 'John',
        lastName: null,
        gender: null,
        birthDate: null,
        avatarUrl: null,
        socials: {
          id: 's1',
          instagram: '@johndoe',
          whatsapp: '+5511999999999',
          x: '@johndoe',
          threads: null,
          youtube: null,
          linkedin: null,
          facebook: null,
        },
      });

      const result = await getUserProfileById('u1', ['socials']);

      expect(result).toHaveProperty('socials');
      expect(result.socials).toMatchObject({
        id: 's1',
        instagram: '@johndoe',
        whatsapp: '+5511999999999',
      });
      expect(result).not.toHaveProperty('address');
      expect(result).not.toHaveProperty('preferences');
    });

    it('returns multiple relations when multiple are requested', async () => {
      prisma.user.findUnique.mockResolvedValue({
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
          line1: '123 Main St',
          line2: null,
          neighborhood: null,
          city: 'São Paulo',
          state: null,
          stateCode: null,
          country: null,
          countryCode: null,
          postalCode: null,
        },
        preferences: {
          activeProfile: 'student',
          rawPreferences: { theme: 'dark' },
        },
      });

      const result = await getUserProfileById('u1', ['address', 'preferences']);

      expect(result).toHaveProperty('address');
      expect(result).toHaveProperty('preferences');
      expect(result.address.city).toBe('São Paulo');
      expect(result.preferences.activeProfile).toBe('student');
      expect(result).not.toHaveProperty('socials');
    });

    it('handles null relations correctly', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: 'test@example.com',
        roles: ['student'],
        status: 'active',
        firstName: 'John',
        lastName: null,
        gender: null,
        birthDate: null,
        avatarUrl: null,
        address: null,
        socials: null,
      });

      const result = await getUserProfileById('u1', ['address', 'socials']);

      expect(result).toHaveProperty('address', null);
      expect(result).toHaveProperty('socials', null);
    });
  });

  describe('hasActiveTrainer flag', () => {
    const baseUser = {
      id: 'u1',
      email: 'test@example.com',
      roles: ['student'],
      status: 'active',
      firstName: 'John',
      lastName: null,
      gender: null,
      birthDate: null,
      avatarUrl: null,
    };

    describe('getUserProfileById', () => {
      it('returns hasActiveTrainer: false when no TrainerStudent record exists for the user', async () => {
        prisma.user.findUnique.mockResolvedValue(baseUser);
        prisma.trainerStudent.findFirst.mockResolvedValue(null);

        const result = await getUserProfileById('u1', []);

        expect(result.hasActiveTrainer).toBe(false);
        expect(prisma.trainerStudent.findFirst).toHaveBeenCalledWith({
          where: { studentId: 'u1' },
          select: { id: true },
        });
      });

      it('returns hasActiveTrainer: true when at least one TrainerStudent record exists for the user', async () => {
        prisma.user.findUnique.mockResolvedValue(baseUser);
        prisma.trainerStudent.findFirst.mockResolvedValue({ id: 'ts1' });

        const result = await getUserProfileById('u1', []);

        expect(result.hasActiveTrainer).toBe(true);
        expect(prisma.trainerStudent.findFirst).toHaveBeenCalledWith({
          where: { studentId: 'u1' },
          select: { id: true },
        });
      });
    });

    describe('updateUserProfile', () => {
      it('returns hasActiveTrainer: false when no TrainerStudent record exists for the user', async () => {
        prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
        prisma.user.update.mockResolvedValue({ ...baseUser, address: null, socials: null, preferences: null });
        prisma.trainerStudent.findFirst.mockResolvedValue(null);

        const result = await updateUserProfile('u1', { firstName: 'John' });

        expect(result.hasActiveTrainer).toBe(false);
        expect(prisma.trainerStudent.findFirst).toHaveBeenCalledWith({
          where: { studentId: 'u1' },
          select: { id: true },
        });
      });

      it('returns hasActiveTrainer: true when at least one TrainerStudent record exists for the user', async () => {
        prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
        prisma.user.update.mockResolvedValue({ ...baseUser, address: null, socials: null, preferences: null });
        prisma.trainerStudent.findFirst.mockResolvedValue({ id: 'ts1' });

        const result = await updateUserProfile('u1', { firstName: 'John' });

        expect(result.hasActiveTrainer).toBe(true);
        expect(prisma.trainerStudent.findFirst).toHaveBeenCalledWith({
          where: { studentId: 'u1' },
          select: { id: true },
        });
      });
    });
  });
});
