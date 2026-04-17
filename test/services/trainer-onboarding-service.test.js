import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    trainer: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    address: {
      findUnique: vi.fn(),
    },
  },
}));

import { prisma } from '../../src/db.js';
import {
  isProfileDataComplete,
  maybeMarkProfileComplete,
  maybeMarkFirstStudentLinked,
  maybeMarkFirstProtocolCreated,
} from '../../src/services/trainer-onboarding-service.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const completeUser = {
  firstName: 'Ana',
  lastName: 'Silva',
  birthDate: new Date('1990-01-15'),
  gender: 'female',
};

const completeAddress = {
  line1: 'Rua das Flores, 100',
  city: 'São Paulo',
  state: 'SP',
  postalCode: '01310-100',
  country: 'Brazil',
};

// ─── isProfileDataComplete ────────────────────────────────────────────────────

describe('isProfileDataComplete', () => {
  it('returns true when all 9 required fields are present and non-empty', () => {
    expect(isProfileDataComplete({ user: completeUser, address: completeAddress })).toBe(true);
  });

  it('returns false when user is null', () => {
    expect(isProfileDataComplete({ user: null, address: completeAddress })).toBe(false);
  });

  it('returns false when address is null', () => {
    expect(isProfileDataComplete({ user: completeUser, address: null })).toBe(false);
  });

  it('returns false when firstName is missing', () => {
    expect(isProfileDataComplete({ user: { ...completeUser, firstName: null }, address: completeAddress })).toBe(false);
  });

  it('returns false when lastName is missing', () => {
    expect(isProfileDataComplete({ user: { ...completeUser, lastName: undefined }, address: completeAddress })).toBe(false);
  });

  it('returns false when birthDate is missing', () => {
    expect(isProfileDataComplete({ user: { ...completeUser, birthDate: null }, address: completeAddress })).toBe(false);
  });

  it('returns false when gender is missing', () => {
    expect(isProfileDataComplete({ user: { ...completeUser, gender: null }, address: completeAddress })).toBe(false);
  });

  it('returns false when address line1 is missing', () => {
    expect(isProfileDataComplete({ user: completeUser, address: { ...completeAddress, line1: null } })).toBe(false);
  });

  it('returns false when address city is missing', () => {
    expect(isProfileDataComplete({ user: completeUser, address: { ...completeAddress, city: null } })).toBe(false);
  });

  it('returns false when address state is missing', () => {
    expect(isProfileDataComplete({ user: completeUser, address: { ...completeAddress, state: null } })).toBe(false);
  });

  it('returns false when address postalCode is missing', () => {
    expect(isProfileDataComplete({ user: completeUser, address: { ...completeAddress, postalCode: null } })).toBe(false);
  });

  it('returns false when address country is missing', () => {
    expect(isProfileDataComplete({ user: completeUser, address: { ...completeAddress, country: null } })).toBe(false);
  });

  it('returns false when a string field is an empty string', () => {
    expect(isProfileDataComplete({ user: { ...completeUser, firstName: '' }, address: completeAddress })).toBe(false);
  });

  it('returns false when a string field is whitespace-only', () => {
    expect(isProfileDataComplete({ user: { ...completeUser, firstName: '   ' }, address: completeAddress })).toBe(false);
  });

  it('returns false when an address field is an empty string', () => {
    expect(isProfileDataComplete({ user: completeUser, address: { ...completeAddress, city: '' } })).toBe(false);
  });
});

// ─── maybeMarkProfileComplete ─────────────────────────────────────────────────

describe('maybeMarkProfileComplete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is a no-op when trainer row does not exist', async () => {
    prisma.trainer.findUnique.mockResolvedValue(null);

    await maybeMarkProfileComplete({ userId: 'u1' });

    expect(prisma.trainer.updateMany).not.toHaveBeenCalled();
  });

  it('is a no-op when profileCompletedAt is already set', async () => {
    prisma.trainer.findUnique.mockResolvedValue({
      id: 't1',
      profileCompletedAt: new Date('2025-01-01'),
      user: completeUser,
    });

    await maybeMarkProfileComplete({ userId: 'u1' });

    expect(prisma.address.findUnique).not.toHaveBeenCalled();
    expect(prisma.trainer.updateMany).not.toHaveBeenCalled();
  });

  it('is a no-op when address is missing required fields', async () => {
    prisma.trainer.findUnique.mockResolvedValue({
      id: 't1',
      profileCompletedAt: null,
      user: completeUser,
    });
    prisma.address.findUnique.mockResolvedValue({
      line1: 'Rua das Flores',
      city: null,
      state: 'SP',
      postalCode: '01310-100',
      country: 'Brazil',
    });

    await maybeMarkProfileComplete({ userId: 'u1' });

    expect(prisma.trainer.updateMany).not.toHaveBeenCalled();
  });

  it('calls trainer.updateMany with where-null guard when profile is complete', async () => {
    prisma.trainer.findUnique.mockResolvedValue({
      id: 't1',
      profileCompletedAt: null,
      user: completeUser,
    });
    prisma.address.findUnique.mockResolvedValue(completeAddress);
    prisma.trainer.updateMany.mockResolvedValue({ count: 1 });

    await maybeMarkProfileComplete({ userId: 'u1' });

    expect(prisma.trainer.updateMany).toHaveBeenCalledWith({
      where: { id: 't1', profileCompletedAt: null },
      data: { profileCompletedAt: expect.any(Date) },
    });
  });

  it('uses the provided tx instead of the global prisma client', async () => {
    const tx = {
      trainer: {
        findUnique: vi.fn().mockResolvedValue({
          id: 't1',
          profileCompletedAt: null,
          user: completeUser,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      address: {
        findUnique: vi.fn().mockResolvedValue(completeAddress),
      },
    };

    await maybeMarkProfileComplete({ userId: 'u1', tx });

    expect(tx.trainer.findUnique).toHaveBeenCalled();
    expect(tx.address.findUnique).toHaveBeenCalled();
    expect(tx.trainer.updateMany).toHaveBeenCalledWith({
      where: { id: 't1', profileCompletedAt: null },
      data: { profileCompletedAt: expect.any(Date) },
    });
    // Global prisma must not be touched
    expect(prisma.trainer.updateMany).not.toHaveBeenCalled();
  });
});

// ─── maybeMarkFirstStudentLinked ──────────────────────────────────────────────

describe('maybeMarkFirstStudentLinked', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.trainer.updateMany.mockResolvedValue({ count: 0 });
  });

  it('calls trainer.updateMany with where-null guard', async () => {
    await maybeMarkFirstStudentLinked({ trainerId: 't1' });

    expect(prisma.trainer.updateMany).toHaveBeenCalledWith({
      where: { id: 't1', firstStudentLinkedAt: null },
      data: { firstStudentLinkedAt: expect.any(Date) },
    });
  });

  it('calling twice results in two updateMany calls (DB handles idempotency via null guard)', async () => {
    await maybeMarkFirstStudentLinked({ trainerId: 't1' });
    await maybeMarkFirstStudentLinked({ trainerId: 't1' });

    expect(prisma.trainer.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.trainer.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: 't1', firstStudentLinkedAt: null },
      data: { firstStudentLinkedAt: expect.any(Date) },
    });
    expect(prisma.trainer.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 't1', firstStudentLinkedAt: null },
      data: { firstStudentLinkedAt: expect.any(Date) },
    });
  });

  it('uses the provided tx instead of the global prisma client', async () => {
    const tx = {
      trainer: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };

    await maybeMarkFirstStudentLinked({ trainerId: 't1', tx });

    expect(tx.trainer.updateMany).toHaveBeenCalledWith({
      where: { id: 't1', firstStudentLinkedAt: null },
      data: { firstStudentLinkedAt: expect.any(Date) },
    });
    expect(prisma.trainer.updateMany).not.toHaveBeenCalled();
  });
});

// ─── maybeMarkFirstProtocolCreated ───────────────────────────────────────────

describe('maybeMarkFirstProtocolCreated', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.trainer.updateMany.mockResolvedValue({ count: 0 });
  });

  it('calls trainer.updateMany with where-null guard', async () => {
    await maybeMarkFirstProtocolCreated({ trainerId: 't1' });

    expect(prisma.trainer.updateMany).toHaveBeenCalledWith({
      where: { id: 't1', firstProtocolCreatedAt: null },
      data: { firstProtocolCreatedAt: expect.any(Date) },
    });
  });

  it('calling twice results in two updateMany calls (DB handles idempotency via null guard)', async () => {
    await maybeMarkFirstProtocolCreated({ trainerId: 't1' });
    await maybeMarkFirstProtocolCreated({ trainerId: 't1' });

    expect(prisma.trainer.updateMany).toHaveBeenCalledTimes(2);
  });

  it('uses the provided tx instead of the global prisma client', async () => {
    const tx = {
      trainer: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };

    await maybeMarkFirstProtocolCreated({ trainerId: 't1', tx });

    expect(tx.trainer.updateMany).toHaveBeenCalledWith({
      where: { id: 't1', firstProtocolCreatedAt: null },
      data: { firstProtocolCreatedAt: expect.any(Date) },
    });
    expect(prisma.trainer.updateMany).not.toHaveBeenCalled();
  });
});
