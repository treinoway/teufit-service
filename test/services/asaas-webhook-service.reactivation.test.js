import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PLATFORM_PLAN_TIERS,
  PLATFORM_SUBSCRIPTION_STATUSES,
} from '../../src/constants/platform-plan.js';

vi.mock('../../src/services/platform-plan-service.js', () => ({
  enforceStudentCapAfterDowngrade: vi.fn().mockResolvedValue(undefined),
  reactivateStudentsUpToCap: vi.fn().mockResolvedValue(undefined),
}));

import { reactivateStudentsUpToCap } from '../../src/services/platform-plan-service.js';
import { handleWebhookEvent } from '../../src/services/asaas-webhook-service.js';

const mockPrisma = {
  platformSubscription: { findFirst: vi.fn(), update: vi.fn() },
  platformSubscriptionPayment: { findUnique: vi.fn(), upsert: vi.fn() },
};
const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const TRAINER_ID = 'trainer-uuid-1';
const ASAAS_SUB_ID = 'sub_sandbox_001';
const { FREE, PRO } = PLATFORM_PLAN_TIERS;

// Builds a stored subscription with the given tier.
function makeSubscription(tier) {
  return {
    id: 'platsub-uuid-1',
    trainerId: TRAINER_ID,
    tier,
    status: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE,
    asaasSubscriptionId: ASAAS_SUB_ID,
  };
}

// Sends a PAYMENT_CONFIRMED event with the given externalReference.
function confirmPayment(externalReference) {
  return handleWebhookEvent(
    mockPrisma,
    {
      event: 'PAYMENT_CONFIRMED',
      payment: {
        id: 'pay_sandbox_001',
        subscription: ASAAS_SUB_ID,
        value: 49.9,
        dueDate: '2026-05-16',
        billingType: 'PIX',
        externalReference,
        status: 'CONFIRMED',
      },
    },
    silentLogger
  );
}

describe('PAYMENT_CONFIRMED — reactivation only on real upgrades', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.platformSubscriptionPayment.findUnique.mockResolvedValue(null);
    mockPrisma.platformSubscriptionPayment.upsert.mockResolvedValue({});
    mockPrisma.platformSubscription.update.mockResolvedValue({});
  });

  it('does not reactivate on a same-tier renewal (stored PRO, ref PRO)', async () => {
    mockPrisma.platformSubscription.findFirst.mockResolvedValue(makeSubscription(PRO));

    await confirmPayment(`tier:${PRO}:trainer:${TRAINER_ID}`);

    expect(reactivateStudentsUpToCap).not.toHaveBeenCalled();
  });

  it.each([['missing', undefined], ['unparseable', 'garbage-reference']])(
    'does not reactivate when the tier cannot be resolved (%s reference, stored FREE)',
    async (_label, externalReference) => {
      mockPrisma.platformSubscription.findFirst.mockResolvedValue(makeSubscription(FREE));

      await confirmPayment(externalReference);

      expect(reactivateStudentsUpToCap).not.toHaveBeenCalled();
    }
  );

  it('reactivates on an upgrade (stored FREE, ref PRO)', async () => {
    mockPrisma.platformSubscription.findFirst.mockResolvedValue(makeSubscription(FREE));

    await confirmPayment(`tier:${PRO}:trainer:${TRAINER_ID}`);

    expect(reactivateStudentsUpToCap).toHaveBeenCalledWith(mockPrisma, TRAINER_ID);
  });
});
