import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
    userPreferences: { upsert: vi.fn() },
    trainer: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
    platformSubscription: { create: vi.fn(), upsert: vi.fn(), update: vi.fn() },
  },
}));

vi.mock('../../src/services/address-service.js', () => ({ getAddressByPostalCode: vi.fn() }));
vi.mock('../../src/services/trainer-onboarding-service.js', () => ({
  maybeMarkProfileComplete: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/services/platform-plan-service.js', () => ({ buildPlatformPlanForMe: vi.fn() }));

import { prisma } from '../../src/db.js';
import { setActiveProfileToTrainer } from '../../src/services/user-service.js';

const USER_ID = 'user-1';

describe('setActiveProfileToTrainer (become-trainer path) does not grant BETA', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.user.findUnique.mockResolvedValue({ roles: ['student'] });
    prisma.trainer.findUnique.mockResolvedValue(null);
    prisma.trainer.findFirst.mockResolvedValue(null);
    prisma.trainer.create.mockResolvedValue({ id: 'trainer-1', userId: USER_ID });
    prisma.userPreferences.upsert.mockResolvedValue({ userId: USER_ID, activeProfile: 'trainer' });
  });

  it('should not write any platform subscription row', async () => {
    await setActiveProfileToTrainer(USER_ID);

    expect(prisma.platformSubscription.create).not.toHaveBeenCalled();
    expect(prisma.platformSubscription.upsert).not.toHaveBeenCalled();
    expect(prisma.platformSubscription.update).not.toHaveBeenCalled();
  });
});
