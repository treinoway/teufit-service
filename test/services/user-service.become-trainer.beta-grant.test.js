import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    user: { findUnique: vi.fn(), update: vi.fn() },
    userPreferences: { upsert: vi.fn() },
    trainer: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
    trainerStudent: { count: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    platformSubscription: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock('../../src/config/email-handler.js', () => ({
  default: { sendTrainerWelcomeEmail: vi.fn() },
}));
vi.mock('../../src/services/trainer-example-routine-service.js', () => ({
  seedExampleRoutine: vi.fn(),
}));
vi.mock('../../src/services/address-service.js', () => ({ getAddressByPostalCode: vi.fn() }));
vi.mock('../../src/services/trainer-onboarding-service.js', () => ({
  maybeMarkProfileComplete: vi.fn(),
}));

import { prisma } from '../../src/db.js';
import emailHandler from '../../src/config/email-handler.js';
import { seedExampleRoutine } from '../../src/services/trainer-example-routine-service.js';
import { maybeMarkProfileComplete } from '../../src/services/trainer-onboarding-service.js';
import { setActiveProfileToTrainer } from '../../src/services/user-service.js';
import { Roles } from '../../src/constants/roles.js';
import { PLATFORM_PLAN_TIERS, PLATFORM_SUBSCRIPTION_STATUSES } from '../../src/constants/platform-plan.js';

const USER_ID = 'user-1';
const TRAINER_ID = 'trainer-1';
const TRAINER_EMAIL = 'new.trainer@example.com';
const TRAINER_FIRST_NAME = 'Bia';
const TRAINER_PROFILE = 'trainer';
const ASAAS_SUBSCRIPTION_ID = 'sub_asaas_123';
const UNIQUE_VIOLATION_CODE = 'P2002';
const PAST_DUE_SINCE = new Date('2026-11-10T00:00:00.000Z');

// Builds the error Prisma raises on a unique constraint violation.
function uniqueViolation() {
  return Object.assign(new Error('Unique constraint failed'), { code: UNIQUE_VIOLATION_CODE });
}

// True when a subscription row satisfies the simple equality filters of a where clause.
function matchesSubscription(row, where = {}) {
  return Object.entries(where).every(([field, expected]) => row[field] === expected);
}

// Wires prisma.platformSubscription to an in-memory table keyed by trainerId, so tests assert the stored row.
function installSubscriptionTable(rows = []) {
  const table = new Map(rows.map((row) => [row.trainerId, { ...row }]));
  const insert = (data) => {
    if (table.has(data.trainerId)) throw uniqueViolation();
    table.set(data.trainerId, { asaasSubscriptionId: null, pastDueSince: null, ...data });
    return table.get(data.trainerId);
  };
  const merge = (trainerId, data) => {
    table.set(trainerId, { ...table.get(trainerId), ...data });
    return table.get(trainerId);
  };
  const matching = (where) => [...table.values()].filter((row) => matchesSubscription(row, where));

  const model = prisma.platformSubscription;
  model.findUnique.mockImplementation(async ({ where }) => table.get(where.trainerId) ?? null);
  model.findFirst.mockImplementation(async ({ where }) => matching(where)[0] ?? null);
  model.create.mockImplementation(async ({ data }) => insert(data));
  model.createMany.mockImplementation(async ({ data }) => ({ count: [data].flat().map(insert).length }));
  model.upsert.mockImplementation(async ({ where, create, update }) =>
    table.has(where.trainerId) ? merge(where.trainerId, update) : insert(create),
  );
  model.update.mockImplementation(async ({ where, data }) => merge(where.trainerId, data));
  model.updateMany.mockImplementation(async ({ where, data }) => ({
    count: matching(where).map((row) => merge(row.trainerId, data)).length,
  }));
  return table;
}

// Makes the mocked prisma behave like a database around the subscription table.
function installDatabase({ trainerExists, subscriptions = [] }) {
  prisma.$transaction.mockImplementation(async (work) => (typeof work === 'function' ? work(prisma) : Promise.all(work)));
  prisma.$queryRaw.mockResolvedValue([]);
  prisma.$executeRaw.mockResolvedValue(0);
  prisma.user.findUnique.mockResolvedValue({ id: USER_ID, roles: [], email: TRAINER_EMAIL, firstName: TRAINER_FIRST_NAME });
  prisma.user.update.mockResolvedValue({ id: USER_ID, roles: [Roles.TRAINER] });
  prisma.userPreferences.upsert.mockResolvedValue({ userId: USER_ID, activeProfile: TRAINER_PROFILE });
  const trainerRow = trainerExists ? { id: TRAINER_ID, userId: USER_ID } : null;
  prisma.trainer.findFirst.mockResolvedValue(trainerRow);
  prisma.trainer.findUnique.mockResolvedValue(trainerRow);
  prisma.trainer.create.mockResolvedValue({ id: TRAINER_ID, userId: USER_ID });
  prisma.trainerStudent.count.mockResolvedValue(0);
  prisma.trainerStudent.findMany.mockResolvedValue([]);
  prisma.trainerStudent.updateMany.mockResolvedValue({ count: 0 });
  return installSubscriptionTable(subscriptions);
}

describe('setActiveProfileToTrainer grants BETA to every new trainer profile', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    maybeMarkProfileComplete.mockResolvedValue(undefined);
    seedExampleRoutine.mockResolvedValue(undefined);
    emailHandler.sendTrainerWelcomeEmail.mockResolvedValue(undefined);
  });

  describe('when the Trainer row is created (become-trainer without an invite)', () => {
    let subscriptions;

    beforeEach(() => {
      subscriptions = installDatabase({ trainerExists: false });
    });

    it('should store an ACTIVE BETA platform subscription for the new trainer', async () => {
      await setActiveProfileToTrainer(USER_ID);

      expect(subscriptions.get(TRAINER_ID)).toMatchObject({
        trainerId: TRAINER_ID,
        tier: PLATFORM_PLAN_TIERS.BETA,
        status: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE,
      });
    });

    it('should store exactly one subscription row', async () => {
      await setActiveProfileToTrainer(USER_ID);

      expect(subscriptions.size).toBe(1);
    });

    it('should not link the granted subscription to Asaas', async () => {
      await setActiveProfileToTrainer(USER_ID);

      expect(subscriptions.has(TRAINER_ID)).toBe(true);
      expect(subscriptions.get(TRAINER_ID).asaasSubscriptionId ?? null).toBeNull();
    });

    it('should seed the example routine exactly once', async () => {
      await setActiveProfileToTrainer(USER_ID);

      expect(seedExampleRoutine).toHaveBeenCalledTimes(1);
      expect(seedExampleRoutine).toHaveBeenCalledWith(expect.objectContaining({ trainerId: TRAINER_ID }));
    });

    it('should send the welcome email exactly once', async () => {
      await setActiveProfileToTrainer(USER_ID);

      expect(emailHandler.sendTrainerWelcomeEmail).toHaveBeenCalledTimes(1);
      expect(emailHandler.sendTrainerWelcomeEmail).toHaveBeenCalledWith(expect.objectContaining({ to: TRAINER_EMAIL }));
    });

    it('should still make trainer the active profile', async () => {
      await expect(setActiveProfileToTrainer(USER_ID)).resolves.toMatchObject({ activeProfile: TRAINER_PROFILE });
    });
  });

  describe('when the Trainer row already exists (re-activation)', () => {
    it.each([
      [
        'a paid tier billed through Asaas',
        { tier: PLATFORM_PLAN_TIERS.PRO, status: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE, asaasSubscriptionId: ASAAS_SUBSCRIPTION_ID, pastDueSince: null },
      ],
      [
        'a past-due paid tier',
        { tier: PLATFORM_PLAN_TIERS.PLATINUM, status: PLATFORM_SUBSCRIPTION_STATUSES.PAST_DUE, asaasSubscriptionId: ASAAS_SUBSCRIPTION_ID, pastDueSince: PAST_DUE_SINCE },
      ],
      [
        'a FREE row with an Asaas checkout attached',
        { tier: PLATFORM_PLAN_TIERS.FREE, status: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE, asaasSubscriptionId: ASAAS_SUBSCRIPTION_ID, pastDueSince: null },
      ],
      [
        'an admin-granted DIAMOND tier',
        { tier: PLATFORM_PLAN_TIERS.DIAMOND, status: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE, asaasSubscriptionId: null, pastDueSince: null },
      ],
    ])('should leave %s untouched', async (_label, subscription) => {
      const existing = { trainerId: TRAINER_ID, ...subscription };
      const subscriptions = installDatabase({ trainerExists: true, subscriptions: [existing] });

      await setActiveProfileToTrainer(USER_ID);

      expect(subscriptions.get(TRAINER_ID)).toEqual(existing);
    });

    it('should not seed the example routine or send the welcome email again', async () => {
      installDatabase({
        trainerExists: true,
        subscriptions: [{ trainerId: TRAINER_ID, tier: PLATFORM_PLAN_TIERS.BETA, status: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE }],
      });

      await setActiveProfileToTrainer(USER_ID);

      expect(seedExampleRoutine).not.toHaveBeenCalled();
      expect(emailHandler.sendTrainerWelcomeEmail).not.toHaveBeenCalled();
    });
  });
});
