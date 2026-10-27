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
  maybeMarkFirstStudentInvited,
  maybeMarkFirstAnamnesisSent,
  maybeMarkBrandingConfigured,
} from '../../src/services/trainer-onboarding-service.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const completeUser = {
  firstName: 'Ana',
  lastName: 'Silva',
  avatarUrl: 'avatars/user-1.jpg',
};


describe('isProfileDataComplete', () => {
  it('returns true when firstName, lastName and avatarUrl are present', () => {
    expect(isProfileDataComplete({ user: completeUser })).toBe(true);
  });

  it('returns true without birthDate, gender or address', () => {
    expect(isProfileDataComplete({ user: completeUser, address: null })).toBe(true);
  });

  it('returns false when user is null', () => {
    expect(isProfileDataComplete({ user: null })).toBe(false);
  });

  it.each([
    ['firstName', null],
    ['lastName', undefined],
    ['avatarUrl', null],
  ])('returns false when %s is missing', (field, value) => {
    expect(isProfileDataComplete({ user: { ...completeUser, [field]: value } })).toBe(false);
  });

  it.each([
    ['firstName', ''],
    ['lastName', '   '],
    ['avatarUrl', ''],
  ])('returns false when %s is blank', (field, value) => {
    expect(isProfileDataComplete({ user: { ...completeUser, [field]: value } })).toBe(false);
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

    expect(prisma.trainer.updateMany).not.toHaveBeenCalled();
  });

  it('is a no-op when avatarUrl is missing', async () => {
    prisma.trainer.findUnique.mockResolvedValue({
      id: 't1',
      profileCompletedAt: null,
      user: { ...completeUser, avatarUrl: null },
    });

    await maybeMarkProfileComplete({ userId: 'u1' });

    expect(prisma.trainer.updateMany).not.toHaveBeenCalled();
  });

  it('selects avatarUrl on the trainer user lookup', async () => {
    prisma.trainer.findUnique.mockResolvedValue(null);

    await maybeMarkProfileComplete({ userId: 'u1' });

    expect(prisma.trainer.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          user: { select: expect.objectContaining({ avatarUrl: true }) },
        }),
      }),
    );
  });

  it('marks the profile complete without reading the address when name and avatar are set', async () => {
    prisma.trainer.findUnique.mockResolvedValue({
      id: 't1',
      profileCompletedAt: null,
      user: completeUser,
    });
    prisma.trainer.updateMany.mockResolvedValue({ count: 1 });

    await maybeMarkProfileComplete({ userId: 'u1' });

    expect(prisma.address.findUnique).not.toHaveBeenCalled();
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
    };

    await maybeMarkProfileComplete({ userId: 'u1', tx });

    expect(tx.trainer.updateMany).toHaveBeenCalledWith({
      where: { id: 't1', profileCompletedAt: null },
      data: { profileCompletedAt: expect.any(Date) },
    });
    expect(prisma.trainer.updateMany).not.toHaveBeenCalled();
  });
});


describe.each([
  ['maybeMarkFirstStudentInvited', maybeMarkFirstStudentInvited, 'firstStudentInvitedAt'],
  ['maybeMarkFirstAnamnesisSent', maybeMarkFirstAnamnesisSent, 'firstAnamnesisSentAt'],
  ['maybeMarkBrandingConfigured', maybeMarkBrandingConfigured, 'brandingConfiguredAt'],
])('%s', (_name, setter, column) => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.trainer.updateMany.mockResolvedValue({ count: 0 });
  });

  it(`calls trainer.updateMany with a where-null guard on ${column}`, async () => {
    await setter({ trainerId: 't1' });

    expect(prisma.trainer.updateMany).toHaveBeenCalledWith({
      where: { id: 't1', [column]: null },
      data: { [column]: expect.any(Date) },
    });
  });

  it('is idempotent: repeated calls always carry the null guard', async () => {
    await setter({ trainerId: 't1' });
    await setter({ trainerId: 't1' });

    expect(prisma.trainer.updateMany).toHaveBeenCalledTimes(2);
    for (const [args] of prisma.trainer.updateMany.mock.calls) {
      expect(args.where).toEqual({ id: 't1', [column]: null });
    }
  });

  it('uses the provided tx instead of the global prisma client', async () => {
    const tx = { trainer: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) } };

    await setter({ trainerId: 't1', tx });

    expect(tx.trainer.updateMany).toHaveBeenCalledWith({
      where: { id: 't1', [column]: null },
      data: { [column]: expect.any(Date) },
    });
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
