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
        findUnique: vi.fn(),
        create: vi.fn(),
      },
      trainerStudent: {
        findFirst: vi.fn(),
      },
      trainerInvite: {
        findFirst: vi.fn(),
      },
      account: {
        findFirst: vi.fn(),
      },
    },
  };
});

vi.mock('../../src/services/address-service.js', () => ({
  getAddressByPostalCode: vi.fn(),
}));

vi.mock('../../src/services/trainer-onboarding-service.js', () => ({
  maybeMarkProfileComplete: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/services/trainer-example-routine-service.js', () => ({
  seedExampleRoutine: vi.fn(),
}));

vi.mock('../../src/config/email-handler.js', () => ({
  default: { sendTrainerWelcomeEmail: vi.fn() },
}));

vi.mock('../../src/services/platform-plan-service.js', () => ({
  buildPlatformPlanForMe: vi.fn(),
}));

import { prisma } from '../../src/db.js';
import { getAddressByPostalCode } from '../../src/services/address-service.js';
import { maybeMarkProfileComplete } from '../../src/services/trainer-onboarding-service.js';
import { buildPlatformPlanForMe } from '../../src/services/platform-plan-service.js';
import { getUserProfileById, setActiveProfileToTrainer, updateUserProfile } from '../../src/services/user-service.js';
import config from '../../config/index.js';

describe('userService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no active trainer link — individual tests override when needed
    prisma.trainerStudent.findFirst.mockResolvedValue(null);
    // Default: no accepted invite — betaAccess falls through to false for
    // plain student users (hasBetaAccess invite lookup)
    prisma.trainerInvite.findFirst.mockResolvedValue(null);
    // Default: no trainer profile (student-only user)
    prisma.trainer.findUnique.mockResolvedValue(null);
    // Default: no verified account — emailVerified is false
    prisma.account.findFirst.mockResolvedValue(null);
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
    // This test asserts betaAccess: false via the accepted-invite DB lookup
    // path (prisma.trainerInvite.findFirst mocked to null in beforeEach) for
    // a plain 'student'-role user. Force the kill-switch on — it defaults
    // OFF in the test environment (config/environments/test.js), which would
    // otherwise short-circuit hasBetaAccess to true before ever touching the
    // DB. Capture/restore the prior value (rather than hardcoding `false`)
    // so state doesn't leak into other tests, and set the flag immediately
    // before the try so a throw in between can't leave it stuck on.
    const originalGateEnabled = config.betaInviteGate.enabled;
    config.betaInviteGate.enabled = true;
    try {
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
    betaAccess: false,
    emailVerified: false,
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
  } finally {
    config.betaInviteGate.enabled = originalGateEnabled;
  }
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
    prisma.trainer.create.mockResolvedValue({ id: 't1' });
    prisma.user.findUnique.mockResolvedValue({ roles: ['student'] });
    prisma.userPreferences.upsert.mockResolvedValue({
      id: 'pref1',
      userId: 'u1',
      activeProfile: 'trainer',
    });

    const result = await setActiveProfileToTrainer('u1');

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
    where: { id: 'u1' },
    select: { roles: true, email: true, firstName: true },
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

    expect(maybeMarkProfileComplete).toHaveBeenCalledWith({ userId: 'u1' });

    expect(result).toEqual({
      id: 'pref1',
      userId: 'u1',
      activeProfile: 'trainer',
    });
  });

  it('setActiveProfileToTrainer does not duplicate TRAINER role', async () => {
  prisma.trainer.create.mockResolvedValue({ id: 't2' });
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
  expect(maybeMarkProfileComplete).toHaveBeenCalledWith({ userId: 'u2' });
  expect(result).toEqual({
    id: 'pref2',
    userId: 'u2',
    activeProfile: 'trainer',
  });
  });

  it('setActiveProfileToTrainer always calls maybeMarkProfileComplete to check profile milestone on role upgrade', async () => {
    prisma.trainer.create.mockResolvedValue({ id: 't3' });
    prisma.user.findUnique.mockResolvedValue({ roles: ['student'] });
    prisma.userPreferences.upsert.mockResolvedValue({
      id: 'pref3',
      userId: 'u3',
      activeProfile: 'trainer',
    });

    await setActiveProfileToTrainer('u3');

    expect(maybeMarkProfileComplete).toHaveBeenCalledWith({ userId: 'u3' });
  });

  it('setActiveProfileToTrainer runs every step on the given transaction client, never the global one', async () => {
    const tx = {
      user: { findUnique: vi.fn().mockResolvedValue({ roles: [] }), update: vi.fn().mockResolvedValue({}) },
      trainer: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 't-tx' }) },
      userPreferences: { upsert: vi.fn().mockResolvedValue({ userId: 'u-tx', activeProfile: 'trainer' }) },
    };

    const result = await setActiveProfileToTrainer('u-tx', { tx });

    expect(tx.user.update).toHaveBeenCalledWith({ where: { id: 'u-tx' }, data: { roles: { set: ['trainer'] } } });
    expect(tx.trainer.create).toHaveBeenCalledWith({ data: { userId: 'u-tx' } });
    expect(maybeMarkProfileComplete).toHaveBeenCalledWith({ userId: 'u-tx', tx });
    expect(tx.userPreferences.upsert).toHaveBeenCalledWith({
      where: { userId: 'u-tx' },
      create: { userId: 'u-tx', activeProfile: 'trainer' },
      update: { activeProfile: 'trainer' },
    });
    expect(result).toEqual({ userId: 'u-tx', activeProfile: 'trainer' });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.trainer.findFirst).not.toHaveBeenCalled();
    expect(prisma.trainer.create).not.toHaveBeenCalled();
    expect(prisma.userPreferences.upsert).not.toHaveBeenCalled();
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

    it('does NOT call maybeMarkProfileComplete when the user is a student (no trainer role)', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
      prisma.user.update.mockResolvedValue({
        id: 'u1',
        email: 'student@example.com',
        roles: ['student'],
        status: 'active',
        firstName: 'John',
        lastName: 'Doe',
        gender: 'male',
        birthDate: new Date('1990-01-15'),
        avatarUrl: null,
        address: null,
        socials: null,
        preferences: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-28T00:00:00.000Z'),
      });

      await updateUserProfile('u1', {
        firstName: 'John',
        lastName: 'Doe',
        gender: 'male',
        birthDate: '1990-01-15',
      });

      expect(maybeMarkProfileComplete).not.toHaveBeenCalled();
    });
  });

  describe('getUserProfileById with lazy loading', () => {
    it('returns minimal payload when no relations are requested', async () => {
      // Same rationale as the 'all relations' test above: this asserts
      // betaAccess: false via the accepted-invite DB lookup path for a plain
      // 'student'-role user, so the kill-switch (OFF by default in the test
      // environment) must be forced on to reach that code path at all.
      // Capture/restore the prior value and set the flag immediately before
      // the try so a throw in between can't leave it stuck on.
      const originalGateEnabled = config.betaInviteGate.enabled;
      config.betaInviteGate.enabled = true;

      let result;
      try {
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

        result = await getUserProfileById('u1', []);
      } finally {
        config.betaInviteGate.enabled = originalGateEnabled;
      }

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
        betaAccess: false,
        emailVerified: false,
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

  describe('platformPlan in getUserProfileById', () => {
    const baseUser = {
      id: 'u1',
      email: 'trainer@example.com',
      roles: ['trainer'],
      status: 'active',
      firstName: 'José',
      lastName: 'Demo',
      gender: 'male',
      birthDate: null,
      avatarUrl: null,
    };

    const mockPlan = {
      tier: 'FREE',
      status: 'ACTIVE',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      limits: { studentCap: 3, aiActionsPerStudent: 0, aiActionsTrainerCap: 0, branding: false, championships: false },
      usage: {
        students: { active: 1, blocked: 0, cap: 3 },
        aiActions: { total: 0, byStudent: [] },
      },
    };

    it('includes platformPlan when user has TRAINER role and trainer record exists', async () => {
      prisma.user.findUnique.mockResolvedValue({ ...baseUser, trainer: { id: 'trainer-id-1' } });
      buildPlatformPlanForMe.mockResolvedValue(mockPlan);

      const result = await getUserProfileById('u1', []);

      expect(result).toHaveProperty('platformPlan');
      expect(result.platformPlan).toEqual(mockPlan);
      expect(buildPlatformPlanForMe).toHaveBeenCalledOnce();
      expect(buildPlatformPlanForMe).toHaveBeenCalledWith(
        expect.anything(), // prisma singleton
        'trainer-id-1'
      );
    });

    it('omits platformPlan when user is student-only (no TRAINER role)', async () => {
      prisma.user.findUnique.mockResolvedValue({
        ...baseUser,
        roles: ['student'],
        trainer: null,
      });

      const result = await getUserProfileById('u1', []);

      expect(result).not.toHaveProperty('platformPlan');
      expect(buildPlatformPlanForMe).not.toHaveBeenCalled();
    });

    it('omits platformPlan when user has TRAINER role but no trainer DB record', async () => {
      // trainer row does not exist yet (relation is null in the DB)
      prisma.user.findUnique.mockResolvedValue({ ...baseUser, trainer: null });

      const result = await getUserProfileById('u1', []);

      expect(result).not.toHaveProperty('platformPlan');
      expect(buildPlatformPlanForMe).not.toHaveBeenCalled();
    });

    it('resolves trainer.id from the user row without a separate trainer query', async () => {
      // The optimisation: trainer.id is fetched in the same user query, so
      // prisma.trainer.findUnique must never be called.
      prisma.user.findUnique.mockResolvedValue({ ...baseUser, trainer: { id: 'internal-trainer-id' } });
      buildPlatformPlanForMe.mockResolvedValue(mockPlan);

      await getUserProfileById('u1', []);

      expect(prisma.trainer.findUnique).not.toHaveBeenCalled();
      expect(buildPlatformPlanForMe).toHaveBeenCalledWith(expect.anything(), 'internal-trainer-id');
    });

    it('returns PLATINUM plan details correctly when trainer is on PLATINUM', async () => {
      const platinumPlan = {
        tier: 'PLATINUM',
        status: 'ACTIVE',
        currentPeriodEnd: '2026-06-16T00:00:00.000Z',
        cancelAtPeriodEnd: false,
        limits: { studentCap: 80, aiActionsPerStudent: 3, aiActionsTrainerCap: null, branding: true, championships: true },
        usage: {
          students: { active: 50, blocked: 0, cap: 80 },
          aiActions: { total: 5, byStudent: [{ studentId: 's1', count: 2 }, { studentId: 's2', count: 3 }] },
        },
      };

      prisma.user.findUnique.mockResolvedValue({ ...baseUser, trainer: { id: 'trainer-id-1' } });
      buildPlatformPlanForMe.mockResolvedValue(platinumPlan);

      const result = await getUserProfileById('u1', []);

      expect(result.platformPlan.tier).toBe('PLATINUM');
      expect(result.platformPlan.usage.students.active).toBe(50);
      expect(result.platformPlan.usage.aiActions.total).toBe(5);
      expect(result.platformPlan.usage.aiActions.byStudent).toHaveLength(2);
    });

    it('returns DIAMOND plan with null caps for unlimited limits', async () => {
      const diamondPlan = {
        tier: 'DIAMOND',
        status: 'ACTIVE',
        currentPeriodEnd: '2026-06-16T00:00:00.000Z',
        cancelAtPeriodEnd: false,
        limits: { studentCap: null, aiActionsPerStudent: null, aiActionsTrainerCap: 1000, branding: true, championships: true },
        usage: {
          students: { active: 200, blocked: 0, cap: null },
          aiActions: { total: 0, byStudent: [] },
        },
      };

      prisma.user.findUnique.mockResolvedValue({ ...baseUser, trainer: { id: 'trainer-id-1' } });
      buildPlatformPlanForMe.mockResolvedValue(diamondPlan);

      const result = await getUserProfileById('u1', []);

      expect(result.platformPlan.tier).toBe('DIAMOND');
      expect(result.platformPlan.limits.studentCap).toBeNull();
      expect(result.platformPlan.limits.aiActionsPerStudent).toBeNull();
      expect(result.platformPlan.limits.aiActionsTrainerCap).toBe(1000);
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

    describe('emailVerified flag', () => {
      it('returns emailVerified: true from getUserProfileById when an account has verifiedAt', async () => {
        prisma.user.findUnique.mockResolvedValue(baseUser);
        prisma.account.findFirst.mockResolvedValue({ id: 'acc1' });

        const result = await getUserProfileById('u1', []);

        expect(result.emailVerified).toBe(true);
        expect(prisma.account.findFirst).toHaveBeenCalledWith({
          where: { userId: 'u1', verifiedAt: { not: null } },
          select: { id: true },
        });
      });

      it('returns emailVerified: false from getUserProfileById when no account is verified', async () => {
        prisma.user.findUnique.mockResolvedValue(baseUser);
        prisma.account.findFirst.mockResolvedValue(null);

        const result = await getUserProfileById('u1', []);

        expect(result.emailVerified).toBe(false);
      });

      it('returns emailVerified: true from updateUserProfile when an account has verifiedAt', async () => {
        prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
        prisma.user.update.mockResolvedValue({ ...baseUser, address: null, socials: null, preferences: null });
        prisma.account.findFirst.mockResolvedValue({ id: 'acc1' });

        const result = await updateUserProfile('u1', { firstName: 'John' });

        expect(result.emailVerified).toBe(true);
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

  describe('getUserProfileById trainerOnboarding mapping', () => {
    const FIRST_INVITED_AT = new Date('2026-03-01T10:00:00.000Z');
    const FIRST_ANAMNESIS_AT = new Date('2026-03-02T10:00:00.000Z');
    const BRANDING_AT = new Date('2026-03-03T10:00:00.000Z');

    const baseUser = {
      id: 'u1',
      email: 'trainer@example.com',
      roles: ['trainer'],
      status: 'active',
      firstName: 'Ana',
      lastName: 'Silva',
      gender: null,
      birthDate: null,
      avatarUrl: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: null,
    };

    const trainerRow = (overrides = {}) => ({
      profileCompletedAt: null,
      firstStudentLinkedAt: null,
      firstProtocolCreatedAt: null,
      firstStudentInvitedAt: null,
      firstAnamnesisSentAt: null,
      brandingConfiguredAt: null,
      ...overrides,
    });

    it('exposes the new milestone timestamps as ISO strings and the matching booleans as true', async () => {
      prisma.user.findUnique.mockResolvedValue({
        ...baseUser,
        trainer: trainerRow({
          firstStudentInvitedAt: FIRST_INVITED_AT,
          firstAnamnesisSentAt: FIRST_ANAMNESIS_AT,
          brandingConfiguredAt: BRANDING_AT,
        }),
      });

      const result = await getUserProfileById('u1', ['trainerOnboarding']);

      expect(result.trainerOnboarding).toMatchObject({
        firstStudentInvitedAt: FIRST_INVITED_AT.toISOString(),
        firstStudentInvited: true,
        firstAnamnesisSentAt: FIRST_ANAMNESIS_AT.toISOString(),
        firstAnamnesisSent: true,
        brandingConfiguredAt: BRANDING_AT.toISOString(),
        brandingConfigured: true,
      });
    });

    it('exposes null timestamps and false booleans for milestones not reached', async () => {
      prisma.user.findUnique.mockResolvedValue({ ...baseUser, trainer: trainerRow() });

      const result = await getUserProfileById('u1', ['trainerOnboarding']);

      expect(result.trainerOnboarding).toMatchObject({
        firstStudentInvitedAt: null,
        firstStudentInvited: false,
        firstAnamnesisSentAt: null,
        firstAnamnesisSent: false,
        brandingConfiguredAt: null,
        brandingConfigured: false,
      });
    });
  });
});
