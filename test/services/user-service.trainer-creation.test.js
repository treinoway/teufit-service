import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => {
  const prisma = {
    user: { findUnique: vi.fn(), update: vi.fn() },
    userPreferences: { upsert: vi.fn() },
    trainer: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
    platformSubscription: { create: vi.fn() },
  };
  prisma.$transaction = vi.fn(async (work) => work(prisma));
  return { prisma };
});

vi.mock('../../src/services/trainer-example-routine-service.js', () => ({
  seedExampleRoutine: vi.fn(),
}));

vi.mock('../../src/services/address-service.js', () => ({
  getAddressByPostalCode: vi.fn(),
}));

vi.mock('../../src/services/trainer-onboarding-service.js', () => ({
  maybeMarkProfileComplete: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/services/platform-plan-service.js', () => ({
  buildPlatformPlanForMe: vi.fn(),
}));

import { prisma } from '../../src/db.js';
import { seedExampleRoutine } from '../../src/services/trainer-example-routine-service.js';
import { setActiveProfileToTrainer } from '../../src/services/user-service.js';

describe('setActiveProfileToTrainer example routine', () => {
  const USER_ID = 'u-seed';
  const NEW_TRAINER_ID = 't-new';

  beforeEach(() => {
    prisma.user.findUnique.mockResolvedValue({ roles: ['student'], email: 'new.trainer@example.com', firstName: 'Bia' });
    prisma.userPreferences.upsert.mockResolvedValue({ userId: USER_ID, activeProfile: 'trainer' });
    prisma.trainer.create.mockResolvedValue({ id: NEW_TRAINER_ID });
    seedExampleRoutine.mockResolvedValue(undefined);
  });

  it('should seed the example routine for the new trainer when the Trainer row is created', async () => {
    prisma.trainer.findFirst.mockResolvedValue(null);

    await setActiveProfileToTrainer(USER_ID);

    expect(seedExampleRoutine).toHaveBeenCalledTimes(1);
    expect(seedExampleRoutine).toHaveBeenCalledWith(expect.objectContaining({ trainerId: NEW_TRAINER_ID }));
  });

  it('should not seed again when the Trainer row already exists', async () => {
    prisma.trainer.findFirst.mockResolvedValue({ id: NEW_TRAINER_ID });

    await setActiveProfileToTrainer(USER_ID);

    expect(seedExampleRoutine).not.toHaveBeenCalled();
  });
});
