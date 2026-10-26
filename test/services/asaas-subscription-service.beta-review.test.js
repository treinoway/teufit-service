import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PLATFORM_PLAN_TIERS,
  PLATFORM_SUBSCRIPTION_STATUSES,
  ASAAS_BILLING_TYPES,
  PLAN_LIMITS,
} from '../../src/constants/platform-plan.js';

vi.mock('../../src/billing/asaas-client.js', () => ({
  createCustomer: vi.fn(),
  getCustomer: vi.fn(),
  createSubscription: vi.fn(),
  cancelSubscriptionAtNextCycle: vi.fn(),
  updateSubscription: vi.fn(),
}));

vi.mock('../../src/services/platform-plan-service.js', () => ({
  getTrainerPlan: vi.fn(),
  enforceStudentCapAfterDowngrade: vi.fn().mockResolvedValue(undefined),
  reactivateStudentsUpToCap: vi.fn().mockResolvedValue(undefined),
}));

import * as asaasClient from '../../src/billing/asaas-client.js';
import { getTrainerPlan } from '../../src/services/platform-plan-service.js';
import { createCheckout, changeTier, cancelAtPeriodEnd } from '../../src/services/asaas-subscription-service.js';

const TRAINER_ID = 'trainer-uuid-1';
const ASAAS_SUBSCRIPTION_ID = 'sub_sandbox_001';
const NO_PAID_SUBSCRIPTION_ERROR = 'PLATFORM_PLAN_NO_PAID_SUBSCRIPTION';
const { FREE, PRO, DIAMOND } = PLATFORM_PLAN_TIERS;
const BETA_TIER = 'BETA';

const mockAsaasConfig = { apiKey: 'test-api-key', env: 'sandbox' };
const mockHttpClient = vi.fn();
const mockPrisma = {
  platformSubscription: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  trainer: { findUnique: vi.fn() },
};

// Builds a subscription row with an Asaas link and overridable fields.
function makeSubscription(overrides = {}) {
  return {
    id: 'platsub-uuid-1',
    trainerId: TRAINER_ID,
    tier: PRO,
    status: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE,
    asaasCustomerId: 'cust_001',
    asaasSubscriptionId: ASAAS_SUBSCRIPTION_ID,
    checkoutPendingSince: null,
    ...overrides,
  };
}

// Stubs the plan the service resolves before acting.
function stubCurrentPlan(tier, subscription) {
  getTrainerPlan.mockResolvedValue({
    tier,
    status: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE,
    limits: PLAN_LIMITS[tier],
    subscription,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.trainer.findUnique.mockResolvedValue({
    id: TRAINER_ID,
    user: { firstName: 'Ana', lastName: 'Lima', email: 'ana@example.com' },
  });
  mockPrisma.platformSubscription.update.mockResolvedValue({});
});

describe('createCheckout marks the checkout as unpaid', () => {
  it('should store the Asaas subscription id together with checkoutPendingSince', async () => {
    const subscription = makeSubscription({ tier: FREE, asaasSubscriptionId: null });
    stubCurrentPlan(FREE, subscription);
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(subscription);
    asaasClient.getCustomer.mockResolvedValue({ id: 'cust_001' });
    asaasClient.createSubscription.mockResolvedValue({ id: ASAAS_SUBSCRIPTION_ID, invoiceUrl: 'https://pay' });

    await createCheckout(mockPrisma, mockAsaasConfig, mockHttpClient, {
      trainerId: TRAINER_ID,
      tier: PRO,
      billingType: ASAAS_BILLING_TYPES.PIX,
    });

    expect(mockPrisma.platformSubscription.update).toHaveBeenCalledWith({
      where: { trainerId: TRAINER_ID },
      data: { asaasSubscriptionId: ASAAS_SUBSCRIPTION_ID, checkoutPendingSince: expect.any(Date) },
    });
  });
});

describe('changeTier with an unpaid checkout', () => {
  it.each([FREE, BETA_TIER])('should reject a %s trainer who only started a checkout with 409', async (currentTier) => {
    const subscription = makeSubscription({ tier: currentTier, checkoutPendingSince: new Date() });
    stubCurrentPlan(currentTier, subscription);
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(subscription);

    await expect(
      changeTier(mockPrisma, mockAsaasConfig, mockHttpClient, TRAINER_ID, DIAMOND)
    ).rejects.toMatchObject({ httpStatus: 409, error: NO_PAID_SUBSCRIPTION_ERROR, messageCode: 'resource.conflict' });
    expect(asaasClient.updateSubscription).not.toHaveBeenCalled();
    expect(mockPrisma.platformSubscription.update).not.toHaveBeenCalled();
  });

  it('should change the tier once the payment cleared checkoutPendingSince', async () => {
    const subscription = makeSubscription({ tier: PRO, checkoutPendingSince: null });
    stubCurrentPlan(PRO, subscription);
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(subscription);
    asaasClient.updateSubscription.mockResolvedValue({});

    const result = await changeTier(mockPrisma, mockAsaasConfig, mockHttpClient, TRAINER_ID, DIAMOND);

    expect(result).toEqual({ tier: DIAMOND });
  });
});

describe('cancelAtPeriodEnd with an unpaid checkout', () => {
  it('should reject cancel with 409 and leave the row untouched', async () => {
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(
      makeSubscription({ tier: BETA_TIER, checkoutPendingSince: new Date() })
    );

    await expect(
      cancelAtPeriodEnd(mockPrisma, mockAsaasConfig, mockHttpClient, TRAINER_ID)
    ).rejects.toMatchObject({ httpStatus: 409, error: NO_PAID_SUBSCRIPTION_ERROR });
    expect(mockPrisma.platformSubscription.update).not.toHaveBeenCalled();
    expect(asaasClient.cancelSubscriptionAtNextCycle).not.toHaveBeenCalled();
  });

  it('should cancel once the payment cleared checkoutPendingSince', async () => {
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(makeSubscription());
    asaasClient.cancelSubscriptionAtNextCycle.mockResolvedValue({});

    const result = await cancelAtPeriodEnd(mockPrisma, mockAsaasConfig, mockHttpClient, TRAINER_ID);

    expect(result).toEqual({ cancelAtPeriodEnd: true });
  });
});
