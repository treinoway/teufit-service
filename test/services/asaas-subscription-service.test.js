import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PLATFORM_PLAN_TIERS,
  PLATFORM_SUBSCRIPTION_STATUSES,
  ASAAS_BILLING_TYPES,
} from '../../src/constants/platform-plan.js';

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('../../src/billing/asaas-client.js', () => ({
  createCustomer: vi.fn(),
  getCustomer: vi.fn(),
  createSubscription: vi.fn(),
  cancelSubscriptionAtNextCycle: vi.fn(),
  updateSubscription: vi.fn(),
}));

vi.mock('../../src/services/platform-plan-service.js', () => ({
  getTrainerPlan: vi.fn(),
  syncStudentCapWithPlan: vi.fn().mockResolvedValue(undefined),
}));

import * as asaasClient from '../../src/billing/asaas-client.js';
import { getTrainerPlan, syncStudentCapWithPlan } from '../../src/services/platform-plan-service.js';
import {
  createOrGetAsaasCustomer,
  createCheckout,
  getTrainerSubscription,
  changeTier,
} from '../../src/services/asaas-subscription-service.js';

// ─── Prisma mock ──────────────────────────────────────────────────────────────

const mockPrisma = {
  platformSubscription: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  trainer: {
    findUnique: vi.fn(),
  },
};

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TRAINER_ID = 'trainer-uuid-1';
const ASAAS_CUSTOMER_ID = 'cust_sandbox_001';
const ASAAS_SUBSCRIPTION_ID = 'sub_sandbox_001';

const mockAsaasConfig = { apiKey: 'test-api-key', env: 'sandbox' };
const mockHttpClient = vi.fn();

function makeTrainer(userOverrides = {}) {
  return {
    id: TRAINER_ID,
    user: {
      firstName: 'João',
      lastName: 'Silva',
      email: 'joao@example.com',
      ...userOverrides,
    },
  };
}

function makePlatformSubscription(overrides = {}) {
  return {
    id: 'platsub-uuid-1',
    trainerId: TRAINER_ID,
    tier: PLATFORM_PLAN_TIERS.FREE,
    status: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE,
    asaasCustomerId: null,
    asaasSubscriptionId: null,
    cancelAtPeriodEnd: false,
    ...overrides,
  };
}

function makeAsaasCustomer(overrides = {}) {
  return {
    id: ASAAS_CUSTOMER_ID,
    name: 'João Silva',
    email: 'joao@example.com',
    ...overrides,
  };
}

// ─── createOrGetAsaasCustomer ─────────────────────────────────────────────────

describe('createOrGetAsaasCustomer', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('when subscription already has asaasCustomerId', () => {
    it('returns existing customer and does NOT call createCustomer', async () => {
      const existingCustomer = makeAsaasCustomer();
      mockPrisma.platformSubscription.findUnique.mockResolvedValue(
        makePlatformSubscription({ asaasCustomerId: ASAAS_CUSTOMER_ID }),
      );
      asaasClient.getCustomer.mockResolvedValue(existingCustomer);

      const result = await createOrGetAsaasCustomer(
        mockPrisma,
        mockAsaasConfig,
        mockHttpClient,
        makeTrainer(),
      );

      expect(result).toBe(existingCustomer);
      expect(asaasClient.createCustomer).not.toHaveBeenCalled();
      expect(asaasClient.getCustomer).toHaveBeenCalledOnce();
      expect(asaasClient.getCustomer).toHaveBeenCalledWith(
        mockHttpClient,
        mockAsaasConfig,
        ASAAS_CUSTOMER_ID,
      );
    });
  });

  describe('customer name construction', () => {
    it('builds name from firstName + lastName when both are present', async () => {
      mockPrisma.platformSubscription.findUnique.mockResolvedValue(null);
      const createdCustomer = makeAsaasCustomer({ name: 'João Silva' });
      asaasClient.createCustomer.mockResolvedValue(createdCustomer);
      mockPrisma.platformSubscription.create.mockResolvedValue({});

      await createOrGetAsaasCustomer(
        mockPrisma,
        mockAsaasConfig,
        mockHttpClient,
        makeTrainer({ firstName: 'João', lastName: 'Silva' }),
      );

      expect(asaasClient.createCustomer).toHaveBeenCalledOnce();
      const [, , customerPayload] = asaasClient.createCustomer.mock.calls[0];
      expect(customerPayload.name).toBe('João Silva');
      expect(customerPayload.email).toBe('joao@example.com');
    });

    it('falls back to email when both firstName and lastName are null', async () => {
      mockPrisma.platformSubscription.findUnique.mockResolvedValue(null);
      asaasClient.createCustomer.mockResolvedValue(makeAsaasCustomer({ name: 'joao@example.com' }));
      mockPrisma.platformSubscription.create.mockResolvedValue({});

      await createOrGetAsaasCustomer(
        mockPrisma,
        mockAsaasConfig,
        mockHttpClient,
        makeTrainer({ firstName: null, lastName: null }),
      );

      const [, , customerPayload] = asaasClient.createCustomer.mock.calls[0];
      expect(customerPayload.name).toBe('joao@example.com');
    });

    it('uses only firstName (no trailing space) when lastName is null', async () => {
      mockPrisma.platformSubscription.findUnique.mockResolvedValue(null);
      asaasClient.createCustomer.mockResolvedValue(makeAsaasCustomer({ name: 'João' }));
      mockPrisma.platformSubscription.create.mockResolvedValue({});

      await createOrGetAsaasCustomer(
        mockPrisma,
        mockAsaasConfig,
        mockHttpClient,
        makeTrainer({ firstName: 'João', lastName: null }),
      );

      const [, , customerPayload] = asaasClient.createCustomer.mock.calls[0];
      expect(customerPayload.name).toBe('João');
      expect(customerPayload.name).not.toMatch(/^\s|\s$/);
    });

    it('uses only lastName (no leading space) when firstName is null', async () => {
      mockPrisma.platformSubscription.findUnique.mockResolvedValue(null);
      asaasClient.createCustomer.mockResolvedValue(makeAsaasCustomer({ name: 'Silva' }));
      mockPrisma.platformSubscription.create.mockResolvedValue({});

      await createOrGetAsaasCustomer(
        mockPrisma,
        mockAsaasConfig,
        mockHttpClient,
        makeTrainer({ firstName: null, lastName: 'Silva' }),
      );

      const [, , customerPayload] = asaasClient.createCustomer.mock.calls[0];
      expect(customerPayload.name).toBe('Silva');
      expect(customerPayload.name).not.toMatch(/^\s|\s$/);
    });
  });

  describe('asaasCustomerId caching', () => {
    it('updates existing PlatformSubscription with asaasCustomerId when one already exists', async () => {
      const existingSubscription = makePlatformSubscription({ asaasCustomerId: null });
      mockPrisma.platformSubscription.findUnique.mockResolvedValue(existingSubscription);
      const createdCustomer = makeAsaasCustomer();
      asaasClient.createCustomer.mockResolvedValue(createdCustomer);
      mockPrisma.platformSubscription.update.mockResolvedValue({});

      await createOrGetAsaasCustomer(
        mockPrisma,
        mockAsaasConfig,
        mockHttpClient,
        makeTrainer(),
      );

      expect(mockPrisma.platformSubscription.update).toHaveBeenCalledOnce();
      const { where, data } = mockPrisma.platformSubscription.update.mock.calls[0][0];
      expect(where).toEqual({ trainerId: TRAINER_ID });
      expect(data.asaasCustomerId).toBe(ASAAS_CUSTOMER_ID);
      expect(mockPrisma.platformSubscription.create).not.toHaveBeenCalled();
    });

    it('creates a new FREE/ACTIVE PlatformSubscription when none exists', async () => {
      mockPrisma.platformSubscription.findUnique.mockResolvedValue(null);
      const createdCustomer = makeAsaasCustomer();
      asaasClient.createCustomer.mockResolvedValue(createdCustomer);
      mockPrisma.platformSubscription.create.mockResolvedValue({});

      await createOrGetAsaasCustomer(
        mockPrisma,
        mockAsaasConfig,
        mockHttpClient,
        makeTrainer(),
      );

      expect(mockPrisma.platformSubscription.create).toHaveBeenCalledOnce();
      const { data } = mockPrisma.platformSubscription.create.mock.calls[0][0];
      expect(data.trainerId).toBe(TRAINER_ID);
      expect(data.asaasCustomerId).toBe(ASAAS_CUSTOMER_ID);
      expect(data.tier).toBe(PLATFORM_PLAN_TIERS.FREE);
      expect(data.status).toBe(PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE);
      expect(mockPrisma.platformSubscription.update).not.toHaveBeenCalled();
    });

    it('returns the newly created Asaas customer object', async () => {
      mockPrisma.platformSubscription.findUnique.mockResolvedValue(null);
      const createdCustomer = makeAsaasCustomer();
      asaasClient.createCustomer.mockResolvedValue(createdCustomer);
      mockPrisma.platformSubscription.create.mockResolvedValue({});

      const result = await createOrGetAsaasCustomer(
        mockPrisma,
        mockAsaasConfig,
        mockHttpClient,
        makeTrainer(),
      );

      expect(result).toBe(createdCustomer);
    });
  });
});

// ─── findTrainerWithUser (exercised via createCheckout) ───────────────────────

describe('createCheckout — findTrainerWithUser internals', () => {
  beforeEach(() => vi.clearAllMocks());

  it('queries prisma.trainer.findUnique with firstName/lastName/email select — never with name', async () => {
    // createCheckout calls findTrainerWithUser which does the trainer lookup
    getTrainerPlan.mockResolvedValue({ tier: PLATFORM_PLAN_TIERS.FREE });
    mockPrisma.trainer.findUnique.mockResolvedValue(
      makeTrainer(),
    );
    // createOrGetAsaasCustomer path
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(null);
    const asaasCustomer = makeAsaasCustomer();
    asaasClient.createCustomer.mockResolvedValue(asaasCustomer);
    mockPrisma.platformSubscription.create.mockResolvedValue({});
    asaasClient.createSubscription.mockResolvedValue({
      id: ASAAS_SUBSCRIPTION_ID,
      invoiceUrl: 'https://pay.asaas.com/checkout/001',
      qrCode: null,
    });
    mockPrisma.platformSubscription.update.mockResolvedValue({});

    await createCheckout(mockPrisma, mockAsaasConfig, mockHttpClient, {
      trainerId: TRAINER_ID,
      tier: PLATFORM_PLAN_TIERS.PRO,
      billingType: ASAAS_BILLING_TYPES.PIX,
    });

    expect(mockPrisma.trainer.findUnique).toHaveBeenCalledOnce();
    const [call] = mockPrisma.trainer.findUnique.mock.calls;
    const { include } = call[0];
    expect(include.user.select).toMatchObject({
      firstName: true,
      lastName: true,
      email: true,
    });
    expect(include.user.select).not.toHaveProperty('name');
  });

  it('throws TRAINER_NOT_FOUND (404) when trainer does not exist', async () => {
    getTrainerPlan.mockResolvedValue({ tier: PLATFORM_PLAN_TIERS.FREE });
    mockPrisma.trainer.findUnique.mockResolvedValue(null);

    await expect(
      createCheckout(mockPrisma, mockAsaasConfig, mockHttpClient, {
        trainerId: TRAINER_ID,
        tier: PLATFORM_PLAN_TIERS.PRO,
        billingType: ASAAS_BILLING_TYPES.PIX,
      }),
    ).rejects.toMatchObject({
      httpStatus: 404,
      error: 'TRAINER_NOT_FOUND',
      messageCode: 'trainer.notFound',
    });
  });
});

// ─── createCheckout — additional public-surface tests ─────────────────────────

describe('createCheckout', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws INVALID_TIER (400) when attempting to checkout on FREE tier', async () => {
    await expect(
      createCheckout(mockPrisma, mockAsaasConfig, mockHttpClient, {
        trainerId: TRAINER_ID,
        tier: PLATFORM_PLAN_TIERS.FREE,
        billingType: ASAAS_BILLING_TYPES.PIX,
      }),
    ).rejects.toMatchObject({
      httpStatus: 400,
      error: 'INVALID_TIER',
      messageCode: 'platformPlan.invalidTier',
    });
  });

  it('throws ALREADY_ON_TIER (409) when trainer is already on the requested tier', async () => {
    getTrainerPlan.mockResolvedValue({ tier: PLATFORM_PLAN_TIERS.PRO });
    mockPrisma.trainer.findUnique.mockResolvedValue(makeTrainer());

    await expect(
      createCheckout(mockPrisma, mockAsaasConfig, mockHttpClient, {
        trainerId: TRAINER_ID,
        tier: PLATFORM_PLAN_TIERS.PRO,
        billingType: ASAAS_BILLING_TYPES.PIX,
      }),
    ).rejects.toMatchObject({
      httpStatus: 409,
      error: 'ALREADY_ON_TIER',
      messageCode: 'platformPlan.alreadyOnTier',
    });
  });

  it('returns checkoutUrl, dueDate, amount, and subscriptionId on success', async () => {
    getTrainerPlan.mockResolvedValue({ tier: PLATFORM_PLAN_TIERS.FREE });
    mockPrisma.trainer.findUnique.mockResolvedValue(makeTrainer());
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(null);
    asaasClient.createCustomer.mockResolvedValue(makeAsaasCustomer());
    mockPrisma.platformSubscription.create.mockResolvedValue({});
    asaasClient.createSubscription.mockResolvedValue({
      id: ASAAS_SUBSCRIPTION_ID,
      invoiceUrl: 'https://pay.asaas.com/checkout/001',
      qrCode: null,
    });
    mockPrisma.platformSubscription.update.mockResolvedValue({});

    const result = await createCheckout(mockPrisma, mockAsaasConfig, mockHttpClient, {
      trainerId: TRAINER_ID,
      tier: PLATFORM_PLAN_TIERS.PRO,
      billingType: ASAAS_BILLING_TYPES.PIX,
    });

    expect(result).toMatchObject({
      checkoutUrl: 'https://pay.asaas.com/checkout/001',
      subscriptionId: ASAAS_SUBSCRIPTION_ID,
    });
    expect(typeof result.dueDate).toBe('string');
    expect(result.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof result.amount).toBe('number');
  });
});

// ─── getTrainerSubscription ───────────────────────────────────────────────────

describe('getTrainerSubscription', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the PlatformSubscription row for the given trainerId', async () => {
    const subscription = makePlatformSubscription({ tier: PLATFORM_PLAN_TIERS.PRO });
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(subscription);

    const result = await getTrainerSubscription(mockPrisma, TRAINER_ID);

    expect(result).toBe(subscription);
    expect(mockPrisma.platformSubscription.findUnique).toHaveBeenCalledWith({
      where: { trainerId: TRAINER_ID },
    });
  });

  it('returns null when no subscription exists', async () => {
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(null);

    const result = await getTrainerSubscription(mockPrisma, TRAINER_ID);

    expect(result).toBeNull();
  });
});

// ─── changeTier ───────────────────────────────────────────────────────────────

describe('changeTier', () => {
  beforeEach(() => vi.clearAllMocks());

  function arrange(currentTier) {
    getTrainerPlan.mockResolvedValue({ tier: currentTier });
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(
      makePlatformSubscription({ tier: currentTier, asaasSubscriptionId: ASAAS_SUBSCRIPTION_ID })
    );
    mockPrisma.platformSubscription.update.mockResolvedValue({});
    asaasClient.updateSubscription.mockResolvedValue({});
  }

  it.each([
    ['upgrade', PLATFORM_PLAN_TIERS.PRO, PLATFORM_PLAN_TIERS.DIAMOND],
    ['downgrade', PLATFORM_PLAN_TIERS.DIAMOND, PLATFORM_PLAN_TIERS.PRO],
  ])('reconciles the student cap after persisting the new tier on %s', async (_label, from, to) => {
    arrange(from);

    const result = await changeTier(mockPrisma, mockAsaasConfig, mockHttpClient, TRAINER_ID, to);

    expect(result).toEqual({ tier: to });
    expect(mockPrisma.platformSubscription.update).toHaveBeenCalledWith({
      where: { trainerId: TRAINER_ID },
      data: { tier: to },
    });
    expect(syncStudentCapWithPlan).toHaveBeenCalledOnce();
    expect(syncStudentCapWithPlan).toHaveBeenCalledWith(mockPrisma, TRAINER_ID);
    expect(mockPrisma.platformSubscription.update.mock.invocationCallOrder[0])
      .toBeLessThan(syncStudentCapWithPlan.mock.invocationCallOrder[0]);
  });

  it('rejects a change to the current tier without touching the student cap', async () => {
    arrange(PLATFORM_PLAN_TIERS.PRO);

    await expect(
      changeTier(mockPrisma, mockAsaasConfig, mockHttpClient, TRAINER_ID, PLATFORM_PLAN_TIERS.PRO)
    ).rejects.toMatchObject({ error: 'ALREADY_ON_TIER', httpStatus: 409 });

    expect(mockPrisma.platformSubscription.update).not.toHaveBeenCalled();
    expect(syncStudentCapWithPlan).not.toHaveBeenCalled();
  });
});
