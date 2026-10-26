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
import { getTrainerPlan, enforceStudentCapAfterDowngrade } from '../../src/services/platform-plan-service.js';
import {
  createCheckout,
  changeTier,
  cancelAtPeriodEnd,
} from '../../src/services/asaas-subscription-service.js';

const TRAINER_ID = 'trainer-uuid-1';
const ASAAS_SUBSCRIPTION_ID = 'sub_sandbox_001';
const BETA_TIER = 'BETA';
const NO_PAID_SUBSCRIPTION_ERROR = 'PLATFORM_PLAN_NO_PAID_SUBSCRIPTION';
const CONFLICT_MESSAGE_CODE = 'resource.conflict';
const CONFLICT_STATUS = 409;
const { FREE, PRO, PLATINUM, DIAMOND } = PLATFORM_PLAN_TIERS;

const mockAsaasConfig = { apiKey: 'test-api-key', env: 'sandbox' };
const mockHttpClient = vi.fn();

const mockPrisma = {
  platformSubscription: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  trainer: { findUnique: vi.fn() },
};

// Builds a BETA platform subscription row with overridable fields.
function makeSubscription(overrides = {}) {
  return {
    id: 'platsub-uuid-1',
    trainerId: TRAINER_ID,
    tier: BETA_TIER,
    status: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE,
    asaasCustomerId: null,
    asaasSubscriptionId: null,
    cancelAtPeriodEnd: false,
    ...overrides,
  };
}

// Stubs the plan the service resolves before changing the tier.
function stubCurrentPlan(tier, subscription) {
  getTrainerPlan.mockResolvedValue({
    tier,
    status: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE,
    limits: PLAN_LIMITS[tier],
    subscription,
  });
}

// Asserts the mocked Asaas client was never touched.
function expectNoAsaasCalls() {
  Object.values(asaasClient).forEach((fn) => expect(fn).not.toHaveBeenCalled());
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.trainer.findUnique.mockResolvedValue({
    id: TRAINER_ID,
    user: { firstName: 'Ana', lastName: 'Lima', email: 'ana@example.com' },
  });
});

describe('createCheckout with BETA', () => {
  it('should reject tier BETA with 400 and never call Asaas', async () => {
    stubCurrentPlan(FREE, null);

    await expect(
      createCheckout(mockPrisma, mockAsaasConfig, mockHttpClient, {
        trainerId: TRAINER_ID,
        tier: BETA_TIER,
        billingType: ASAAS_BILLING_TYPES.PIX,
      })
    ).rejects.toMatchObject({ httpStatus: 400 });
    expectNoAsaasCalls();
  });

  it('should allow a BETA trainer to start a PRO checkout', async () => {
    const subscription = makeSubscription({ asaasCustomerId: 'cust_001' });
    stubCurrentPlan(BETA_TIER, subscription);
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(subscription);
    asaasClient.getCustomer.mockResolvedValue({ id: 'cust_001' });
    asaasClient.createSubscription.mockResolvedValue({ id: ASAAS_SUBSCRIPTION_ID, invoiceUrl: 'https://pay' });
    mockPrisma.platformSubscription.update.mockResolvedValue({});

    const result = await createCheckout(mockPrisma, mockAsaasConfig, mockHttpClient, {
      trainerId: TRAINER_ID,
      tier: PRO,
      billingType: ASAAS_BILLING_TYPES.PIX,
    });

    expect(result.subscriptionId).toBe(ASAAS_SUBSCRIPTION_ID);
    expect(asaasClient.createSubscription).toHaveBeenCalledWith(
      mockHttpClient,
      mockAsaasConfig,
      expect.objectContaining({ externalReference: `tier:${PRO}:trainer:${TRAINER_ID}` })
    );
  });
});

describe('changeTier with BETA and unpaid rows', () => {
  it('should reject tier BETA with 400 and never call Asaas', async () => {
    stubCurrentPlan(PRO, makeSubscription({ tier: PRO, asaasSubscriptionId: ASAAS_SUBSCRIPTION_ID }));

    await expect(
      changeTier(mockPrisma, mockAsaasConfig, mockHttpClient, TRAINER_ID, BETA_TIER)
    ).rejects.toMatchObject({ httpStatus: 400 });
    expectNoAsaasCalls();
  });

  it('should throw 409 PLATFORM_PLAN_NO_PAID_SUBSCRIPTION for a BETA trainer without an Asaas subscription', async () => {
    const subscription = makeSubscription();
    stubCurrentPlan(BETA_TIER, subscription);
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(subscription);

    await expect(
      changeTier(mockPrisma, mockAsaasConfig, mockHttpClient, TRAINER_ID, PRO)
    ).rejects.toMatchObject({
      httpStatus: CONFLICT_STATUS,
      error: NO_PAID_SUBSCRIPTION_ERROR,
      messageCode: CONFLICT_MESSAGE_CODE,
    });
  });

  it('should not write the tier when a BETA trainer without an Asaas subscription tries to change', async () => {
    const subscription = makeSubscription();
    stubCurrentPlan(BETA_TIER, subscription);
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(subscription);

    await changeTier(mockPrisma, mockAsaasConfig, mockHttpClient, TRAINER_ID, PRO).catch(() => {});

    expect(mockPrisma.platformSubscription.update).not.toHaveBeenCalled();
  });

  it('should close the free-upgrade hole for any row without asaasSubscriptionId (FREE row to DIAMOND)', async () => {
    const subscription = makeSubscription({ tier: FREE });
    stubCurrentPlan(FREE, subscription);
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(subscription);

    await expect(
      changeTier(mockPrisma, mockAsaasConfig, mockHttpClient, TRAINER_ID, DIAMOND)
    ).rejects.toMatchObject({ httpStatus: CONFLICT_STATUS, error: NO_PAID_SUBSCRIPTION_ERROR });
    expect(mockPrisma.platformSubscription.update).not.toHaveBeenCalled();
  });

  it('should keep the existing 404 SUBSCRIPTION_NOT_FOUND when the trainer has no subscription row', async () => {
    stubCurrentPlan(FREE, null);
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(null);

    await expect(
      changeTier(mockPrisma, mockAsaasConfig, mockHttpClient, TRAINER_ID, PRO)
    ).rejects.toMatchObject({ httpStatus: 404, error: 'SUBSCRIPTION_NOT_FOUND' });
  });

  it('should still change tier through Asaas for a row that has an Asaas subscription', async () => {
    const subscription = makeSubscription({ tier: PRO, asaasSubscriptionId: ASAAS_SUBSCRIPTION_ID });
    stubCurrentPlan(PRO, subscription);
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(subscription);
    asaasClient.updateSubscription.mockResolvedValue({});
    mockPrisma.platformSubscription.update.mockResolvedValue({});

    const result = await changeTier(mockPrisma, mockAsaasConfig, mockHttpClient, TRAINER_ID, PLATINUM);

    expect(result).toEqual({ tier: PLATINUM });
    expect(asaasClient.updateSubscription).toHaveBeenCalledOnce();
  });

  it('should enforce the student cap when a paid BETA-ranked subscription moves down to PRO', async () => {
    const subscription = makeSubscription({ tier: BETA_TIER, asaasSubscriptionId: ASAAS_SUBSCRIPTION_ID });
    stubCurrentPlan(BETA_TIER, subscription);
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(subscription);
    asaasClient.updateSubscription.mockResolvedValue({});
    mockPrisma.platformSubscription.update.mockResolvedValue({});

    await changeTier(mockPrisma, mockAsaasConfig, mockHttpClient, TRAINER_ID, PRO);

    expect(enforceStudentCapAfterDowngrade).toHaveBeenCalledWith(mockPrisma, TRAINER_ID);
  });
});

describe('cancelAtPeriodEnd without a paid subscription', () => {
  it('should throw 409 PLATFORM_PLAN_NO_PAID_SUBSCRIPTION for a BETA trainer without an Asaas subscription', async () => {
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(makeSubscription());

    await expect(
      cancelAtPeriodEnd(mockPrisma, mockAsaasConfig, mockHttpClient, TRAINER_ID)
    ).rejects.toMatchObject({
      httpStatus: CONFLICT_STATUS,
      error: NO_PAID_SUBSCRIPTION_ERROR,
      messageCode: CONFLICT_MESSAGE_CODE,
    });
  });

  it('should not set cancelAtPeriodEnd on a row without an Asaas subscription', async () => {
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(makeSubscription({ tier: FREE }));

    await cancelAtPeriodEnd(mockPrisma, mockAsaasConfig, mockHttpClient, TRAINER_ID).catch(() => {});

    expect(mockPrisma.platformSubscription.update).not.toHaveBeenCalled();
  });

  it('should keep the existing 404 SUBSCRIPTION_NOT_FOUND when the trainer has no subscription row', async () => {
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(null);

    await expect(
      cancelAtPeriodEnd(mockPrisma, mockAsaasConfig, mockHttpClient, TRAINER_ID)
    ).rejects.toMatchObject({ httpStatus: 404, error: 'SUBSCRIPTION_NOT_FOUND' });
  });

  it('should still cancel at next cycle when the row has an Asaas subscription', async () => {
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(
      makeSubscription({ tier: PRO, asaasSubscriptionId: ASAAS_SUBSCRIPTION_ID })
    );
    mockPrisma.platformSubscription.update.mockResolvedValue({});
    asaasClient.cancelSubscriptionAtNextCycle.mockResolvedValue({});

    const result = await cancelAtPeriodEnd(mockPrisma, mockAsaasConfig, mockHttpClient, TRAINER_ID);

    expect(result).toEqual({ cancelAtPeriodEnd: true });
    expect(asaasClient.cancelSubscriptionAtNextCycle).toHaveBeenCalledWith(
      mockHttpClient,
      mockAsaasConfig,
      ASAAS_SUBSCRIPTION_ID
    );
  });
});
