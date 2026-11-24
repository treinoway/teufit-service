import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => {
  const prisma = {
    user: { findUnique: vi.fn(), update: vi.fn() },
    userPreferences: { upsert: vi.fn() },
    trainer: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
    platformSubscription: { create: vi.fn(), upsert: vi.fn(), update: vi.fn() },
  };
  prisma.$transaction = vi.fn(async (work) => work(prisma));
  return { prisma };
});

vi.mock('../../src/services/address-service.js', () => ({ getAddressByPostalCode: vi.fn() }));
vi.mock('../../src/services/trainer-onboarding-service.js', () => ({
  maybeMarkProfileComplete: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/services/platform-plan-service.js', () => ({ buildPlatformPlanForMe: vi.fn() }));
vi.mock('../../src/services/trainer-example-routine-service.js', () => ({ seedExampleRoutine: vi.fn() }));
vi.mock('../../src/config/email-handler.js', () => ({ default: { sendTrainerWelcomeEmail: vi.fn() } }));

import { prisma } from '../../src/db.js';
import { setActiveProfileToTrainer } from '../../src/services/user-service.js';

const USER_ID = 'user-1';
const TRAINER_ID = 'trainer-1';

describe('setActiveProfileToTrainer (become-trainer path) grants BETA only when it creates the Trainer row', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.user.findUnique.mockResolvedValue({ roles: ['student'] });
    prisma.trainer.findUnique.mockResolvedValue(null);
    prisma.trainer.findFirst.mockResolvedValue(null);
    prisma.trainer.create.mockResolvedValue({ id: TRAINER_ID, userId: USER_ID });
    prisma.platformSubscription.create.mockResolvedValue({});
    prisma.userPreferences.upsert.mockResolvedValue({ userId: USER_ID, activeProfile: 'trainer' });
  });

  it('should create the BETA subscription in the same transaction as the Trainer row', async () => {
    await setActiveProfileToTrainer(USER_ID);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.platformSubscription.create).toHaveBeenCalledWith({
      data: { trainerId: TRAINER_ID, tier: 'BETA', status: 'ACTIVE' },
    });
  });

  it('should fail before activating the profile when the subscription cannot be written', async () => {
    prisma.platformSubscription.create.mockRejectedValue(new Error('db down'));

    await expect(setActiveProfileToTrainer(USER_ID)).rejects.toThrow('db down');

    expect(prisma.userPreferences.upsert).not.toHaveBeenCalled();
  });

  it('should not write any platform subscription row when the Trainer row already exists', async () => {
    prisma.trainer.findFirst.mockResolvedValue({ id: TRAINER_ID, userId: USER_ID });

    await setActiveProfileToTrainer(USER_ID);

    expect(prisma.platformSubscription.create).not.toHaveBeenCalled();
    expect(prisma.platformSubscription.upsert).not.toHaveBeenCalled();
    expect(prisma.platformSubscription.update).not.toHaveBeenCalled();
  });
});
