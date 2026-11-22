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

vi.mock('../../src/services/trainer-example-routine-service.js', () => ({
  seedExampleRoutine: vi.fn(),
}));

import { prisma } from '../../src/db.js';
import emailHandler from '../../src/config/email-handler.js';
import { seedExampleRoutine } from '../../src/services/trainer-example-routine-service.js';
import { setActiveProfileToTrainer } from '../../src/services/user-service.js';

describe('setActiveProfileToTrainer welcome email deferral', () => {
  const USER_ID = 'u-deferral';
  const TRAINER_EMAIL = 'deferred.trainer@example.com';
  const TRAINER_FIRST_NAME = 'Caio';
  const NEW_TRAINER_ID = 't-deferred';

  beforeEach(() => {
    prisma.user.findUnique.mockResolvedValue({
      roles: ['student'],
      email: TRAINER_EMAIL,
      firstName: TRAINER_FIRST_NAME,
    });
    prisma.userPreferences.upsert.mockResolvedValue({ userId: USER_ID, activeProfile: 'trainer' });
    prisma.trainer.findFirst.mockResolvedValue(null);
    prisma.trainer.create.mockResolvedValue({ id: NEW_TRAINER_ID });
    seedExampleRoutine.mockResolvedValue(undefined);
    emailHandler.sendTrainerWelcomeEmail.mockResolvedValue(undefined);
  });

  describe('when onCommit is provided and the Trainer row is created', () => {
    const SEED_TASK_INDEX = 0;
    const EMAIL_TASK_INDEX = 1;

    it('should not send the welcome email before the tasks run', async () => {
      const onCommit = vi.fn();

      await setActiveProfileToTrainer(USER_ID, { onCommit });

      expect(emailHandler.sendTrainerWelcomeEmail).not.toHaveBeenCalled();
    });

    it('should not seed the example routine before the tasks run', async () => {
      const onCommit = vi.fn();

      await setActiveProfileToTrainer(USER_ID, { onCommit });

      expect(seedExampleRoutine).not.toHaveBeenCalled();
    });

    it('should hand exactly two tasks to onCommit (seed then email)', async () => {
      const onCommit = vi.fn();

      await setActiveProfileToTrainer(USER_ID, { onCommit });

      expect(onCommit).toHaveBeenCalledTimes(2);
      expect(onCommit).toHaveBeenNthCalledWith(1, expect.any(Function));
      expect(onCommit).toHaveBeenNthCalledWith(2, expect.any(Function));
    });

    it('should seed the example routine on the global client, never the passed tx, once the seed task runs', async () => {
      const onCommit = vi.fn();
      const callerTx = { marker: 'caller-tx', ...prisma };
      await setActiveProfileToTrainer(USER_ID, { tx: callerTx, onCommit });

      await onCommit.mock.calls[SEED_TASK_INDEX][0]();

      expect(seedExampleRoutine).toHaveBeenCalledTimes(1);
      expect(seedExampleRoutine).toHaveBeenCalledWith({ trainerId: NEW_TRAINER_ID, tx: prisma });
    });

    it('should send the welcome email to the user once the email task runs', async () => {
      const onCommit = vi.fn();
      await setActiveProfileToTrainer(USER_ID, { onCommit });

      onCommit.mock.calls[EMAIL_TASK_INDEX][0]();

      expect(emailHandler.sendTrainerWelcomeEmail).toHaveBeenCalledTimes(1);
      expect(emailHandler.sendTrainerWelcomeEmail).toHaveBeenCalledWith({
        to: TRAINER_EMAIL,
        firstName: TRAINER_FIRST_NAME,
      });
    });

    it('should not throw when the welcome email rejects after the task runs', async () => {
      emailHandler.sendTrainerWelcomeEmail.mockRejectedValue(new Error('resend down'));
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const onCommit = vi.fn();
      await setActiveProfileToTrainer(USER_ID, { onCommit });

      expect(() => onCommit.mock.calls[EMAIL_TASK_INDEX][0]()).not.toThrow();
    });
  });

  describe('when onCommit is provided and the Trainer row already exists', () => {
    it('should not hand any task to onCommit', async () => {
      prisma.trainer.findFirst.mockResolvedValue({ id: NEW_TRAINER_ID });
      const onCommit = vi.fn();

      await setActiveProfileToTrainer(USER_ID, { onCommit });

      expect(onCommit).not.toHaveBeenCalled();
    });
  });

  describe('when onCommit is absent', () => {
    it('should seed the example routine immediately on the global client', async () => {
      await setActiveProfileToTrainer(USER_ID);

      expect(seedExampleRoutine).toHaveBeenCalledWith({ trainerId: NEW_TRAINER_ID, tx: prisma });
    });
  });

  describe('when seeding the example routine fails', () => {
    const SEED_TASK_INDEX = 0;
    const EMAIL_TASK_INDEX = 1;

    beforeEach(() => {
      seedExampleRoutine.mockRejectedValue(new Error('seed failed'));
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('should not fail the request when no onCommit is given', async () => {
      await expect(setActiveProfileToTrainer(USER_ID)).resolves.toEqual({
        userId: USER_ID,
        activeProfile: 'trainer',
      });
    });

    it('should still send the welcome email when no onCommit is given', async () => {
      await setActiveProfileToTrainer(USER_ID);

      expect(emailHandler.sendTrainerWelcomeEmail).toHaveBeenCalledTimes(1);
    });

    it('should not reject when the seed task runs after commit', async () => {
      const onCommit = vi.fn();
      await setActiveProfileToTrainer(USER_ID, { onCommit });

      await expect(onCommit.mock.calls[SEED_TASK_INDEX][0]()).resolves.toBeUndefined();
    });

    it('should log the seed failure as non-critical', async () => {
      const onCommit = vi.fn();
      await setActiveProfileToTrainer(USER_ID, { onCommit });

      await onCommit.mock.calls[SEED_TASK_INDEX][0]();

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('seed failed'));
    });

    it('should still let the email task send the welcome email after the seed task failed', async () => {
      const onCommit = vi.fn();
      await setActiveProfileToTrainer(USER_ID, { onCommit });

      await onCommit.mock.calls[SEED_TASK_INDEX][0]();
      onCommit.mock.calls[EMAIL_TASK_INDEX][0]();

      expect(emailHandler.sendTrainerWelcomeEmail).toHaveBeenCalledTimes(1);
    });
  });
});
