import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as platformPlanConstants from '../../src/constants/platform-plan.js';
import {
  getTrainerPlan,
  buildPlatformPlanForMe,
} from '../../src/services/platform-plan-service.js';

const {
  PLAN_LIMITS,
  PLATFORM_PLAN_TIERS,
  PLAN_PRICES,
  isTierUpgrade,
  PURCHASABLE_TIERS,
} = platformPlanConstants;

const TRAINER_ID = 'trainer-uuid-1';
const BETA_TIER = 'BETA';
const { FREE, PRO, PLATINUM, DIAMOND } = PLATFORM_PLAN_TIERS;

const mockPrisma = {
  platformSubscription: { findUnique: vi.fn(), update: vi.fn() },
  trainerStudent: { count: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
  aiUsageEvent: { groupBy: vi.fn() },
};

// Builds an ACTIVE BETA subscription row linked to an Asaas subscription id.
function makeBetaSubscription() {
  return {
    id: 'sub-uuid-1',
    trainerId: TRAINER_ID,
    tier: BETA_TIER,
    status: 'ACTIVE',
    asaasSubscriptionId: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    pastDueSince: null,
  };
}

describe('BETA tier constants', () => {
  it('should expose BETA in PLATFORM_PLAN_TIERS', () => {
    expect(PLATFORM_PLAN_TIERS.BETA).toBe(BETA_TIER);
  });

  it('should give BETA limits that deep-equal DIAMOND limits', () => {
    expect(PLAN_LIMITS.BETA).toEqual(PLAN_LIMITS.DIAMOND);
  });

  it('should keep BETA out of PLAN_PRICES because it is never billed', () => {
    expect(PLAN_PRICES).not.toHaveProperty(BETA_TIER);
  });

  it('should export PURCHASABLE_TIERS as PRO, PLATINUM and DIAMOND only', () => {
    expect(PURCHASABLE_TIERS).toEqual([PRO, PLATINUM, DIAMOND]);
  });

  it('should exclude FREE and BETA from PURCHASABLE_TIERS', () => {
    expect(PURCHASABLE_TIERS).not.toContain(FREE);
    expect(PURCHASABLE_TIERS).not.toContain(BETA_TIER);
  });
});

describe('isTierUpgrade with BETA', () => {
  it('should treat FREE to BETA as an upgrade', () => {
    expect(isTierUpgrade(FREE, BETA_TIER)).toBe(true);
  });

  it('should treat BETA to PRO as not an upgrade', () => {
    expect(isTierUpgrade(BETA_TIER, PRO)).toBe(false);
  });

  it('should treat PRO to BETA as an upgrade', () => {
    expect(isTierUpgrade(PRO, BETA_TIER)).toBe(true);
  });
});

describe('getTrainerPlan for a BETA trainer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(makeBetaSubscription());
  });

  it('should return tier BETA', async () => {
    const result = await getTrainerPlan(mockPrisma, TRAINER_ID);

    expect(result.tier).toBe(BETA_TIER);
  });

  it('should return DIAMOND-equivalent limits instead of silently falling back to FREE', async () => {
    const result = await getTrainerPlan(mockPrisma, TRAINER_ID);

    expect(result.limits).toEqual(PLAN_LIMITS.DIAMOND);
  });
});

describe('buildPlatformPlanForMe for a BETA trainer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(makeBetaSubscription());
    mockPrisma.trainerStudent.count.mockResolvedValue(0);
    mockPrisma.aiUsageEvent.groupBy.mockResolvedValue([]);
  });

  it('should expose tier BETA with limits identical to DIAMOND', async () => {
    const result = await buildPlatformPlanForMe(mockPrisma, TRAINER_ID);

    expect(result.tier).toBe(BETA_TIER);
    expect(result.limits).toEqual({
      studentCap: null,
      aiActionsPerStudent: null,
      aiActionsTrainerCap: 1000,
      branding: true,
      championships: true,
    });
  });

  it('should report an unlimited student cap in usage', async () => {
    const result = await buildPlatformPlanForMe(mockPrisma, TRAINER_ID);

    expect(result.usage.students.cap).toBeNull();
  });
});
