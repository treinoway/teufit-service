import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PLATFORM_SUBSCRIPTION_STATUSES } from '../../src/constants/platform-plan.js';

vi.mock('../../src/services/platform-plan-service.js', () => ({
  enforceStudentCapAfterDowngrade: vi.fn().mockResolvedValue(undefined),
  reactivateStudentsUpToCap: vi.fn().mockResolvedValue(undefined),
}));

import { handleWebhookEvent } from '../../src/services/asaas-webhook-service.js';

const TRAINER_ID = 'trainer-uuid-1';
const ASAAS_SUB_ID = 'sub_sandbox_001';
const ASAAS_PAY_ID = 'pay_sandbox_001';
const BETA_TIER = 'BETA';
const PRO_TIER = 'PRO';

const mockPrisma = {
  platformSubscription: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  platformSubscriptionPayment: {
    findUnique: vi.fn(),
    create: vi.fn(),
    upsert: vi.fn(),
    updateMany: vi.fn(),
  },
};

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

// Builds an ACTIVE BETA subscription row linked to an Asaas subscription id.
function makeBetaSubscription() {
  return {
    id: 'platsub-uuid-1',
    trainerId: TRAINER_ID,
    tier: BETA_TIER,
    status: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE,
    asaasSubscriptionId: ASAAS_SUB_ID,
    pastDueSince: null,
    cancelAtPeriodEnd: false,
    currentPeriodEnd: null,
  };
}

// Builds a confirmed payment payload carrying the given externalReference.
function makePaymentPayload(externalReference) {
  return {
    id: ASAAS_PAY_ID,
    subscription: ASAAS_SUB_ID,
    value: 49.9,
    dueDate: '2026-05-16',
    billingType: 'PIX',
    externalReference,
    status: 'CONFIRMED',
  };
}

describe('PAYMENT_CONFIRMED for a BETA trainer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.platformSubscriptionPayment.findUnique.mockResolvedValue(null);
    mockPrisma.platformSubscription.findFirst.mockResolvedValue(makeBetaSubscription());
    mockPrisma.platformSubscriptionPayment.upsert.mockResolvedValue({});
    mockPrisma.platformSubscription.update.mockResolvedValue({});
  });

  it('should move BETA to PRO when the externalReference is tier:PRO', async () => {
    await handleWebhookEvent(mockPrisma, {
      event: 'PAYMENT_CONFIRMED',
      payment: makePaymentPayload(`tier:${PRO_TIER}:trainer:${TRAINER_ID}`),
    }, silentLogger);

    const updateArgs = mockPrisma.platformSubscription.update.mock.calls[0][0];
    expect(updateArgs.data.tier).toBe(PRO_TIER);
  });

  it('should ignore an externalReference of tier:BETA and not write the tier', async () => {
    await handleWebhookEvent(mockPrisma, {
      event: 'PAYMENT_CONFIRMED',
      payment: makePaymentPayload(`tier:${BETA_TIER}:trainer:${TRAINER_ID}`),
    }, silentLogger);

    expect(mockPrisma.platformSubscription.update).not.toHaveBeenCalled();
  });
});

describe('PAYMENT_CONFIRMED with a BETA reference on a FREE trainer', () => {
  it('should not upgrade a FREE subscription to BETA', async () => {
    vi.clearAllMocks();
    mockPrisma.platformSubscriptionPayment.findUnique.mockResolvedValue(null);
    mockPrisma.platformSubscription.findFirst.mockResolvedValue({ ...makeBetaSubscription(), tier: 'FREE' });
    mockPrisma.platformSubscriptionPayment.upsert.mockResolvedValue({});
    mockPrisma.platformSubscription.update.mockResolvedValue({});

    await handleWebhookEvent(mockPrisma, {
      event: 'PAYMENT_CONFIRMED',
      payment: makePaymentPayload(`tier:${BETA_TIER}:trainer:${TRAINER_ID}`),
    }, silentLogger);

    const tiersWritten = mockPrisma.platformSubscription.update.mock.calls.map(([args]) => args.data.tier);
    expect(tiersWritten).not.toContain(BETA_TIER);
  });
});
