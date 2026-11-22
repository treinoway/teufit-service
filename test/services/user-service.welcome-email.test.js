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

vi.mock('../../src/config/email-handler.js', () => ({
  default: { sendTrainerWelcomeEmail: vi.fn() },
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
import emailHandler from '../../src/config/email-handler.js';
import { setActiveProfileToTrainer } from '../../src/services/user-service.js';

describe('setActiveProfileToTrainer welcome email', () => {
  const USER_ID = 'u-welcome';
  const TRAINER_EMAIL = 'new.trainer@example.com';
  const TRAINER_FIRST_NAME = 'Bia';
  const NEW_TRAINER_ID = 't-new';

  beforeEach(() => {
    prisma.user.findUnique.mockResolvedValue({
      roles: ['student'],
      email: TRAINER_EMAIL,
      firstName: TRAINER_FIRST_NAME,
    });
    prisma.userPreferences.upsert.mockResolvedValue({ userId: USER_ID, activeProfile: 'trainer' });
    prisma.trainer.create.mockResolvedValue({ id: NEW_TRAINER_ID });
    emailHandler.sendTrainerWelcomeEmail.mockResolvedValue(undefined);
  });

  describe('when the Trainer row is created', () => {
    beforeEach(() => {
      prisma.trainer.findFirst.mockResolvedValue(null);
    });

    it('should send the welcome email exactly once to the user email', async () => {
      await setActiveProfileToTrainer(USER_ID);

      expect(emailHandler.sendTrainerWelcomeEmail).toHaveBeenCalledTimes(1);
      expect(emailHandler.sendTrainerWelcomeEmail).toHaveBeenCalledWith(
        expect.objectContaining({ to: TRAINER_EMAIL }),
      );
    });

    it('should not fail the request when the welcome email rejects', async () => {
      emailHandler.sendTrainerWelcomeEmail.mockRejectedValue(new Error('resend down'));
      vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(setActiveProfileToTrainer(USER_ID)).resolves.toEqual({
        userId: USER_ID,
        activeProfile: 'trainer',
      });
    });

    it('should not fail the request when the welcome email throws synchronously', async () => {
      emailHandler.sendTrainerWelcomeEmail.mockImplementation(() => {
        throw new Error('render failed');
      });
      vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(setActiveProfileToTrainer(USER_ID)).resolves.toBeDefined();
    });

  });

  describe('when the Trainer row already exists', () => {
    beforeEach(() => {
      prisma.trainer.findFirst.mockResolvedValue({ id: NEW_TRAINER_ID });
    });

    it('should not send the welcome email on re-activation', async () => {
      await setActiveProfileToTrainer(USER_ID);

      expect(prisma.trainer.create).not.toHaveBeenCalled();
      expect(emailHandler.sendTrainerWelcomeEmail).not.toHaveBeenCalled();
    });

  });

  it('should not send the welcome email when setActiveProfileToTrainer fails before the trainer is created', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(setActiveProfileToTrainer(USER_ID)).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });

    expect(emailHandler.sendTrainerWelcomeEmail).not.toHaveBeenCalled();
  });
});
