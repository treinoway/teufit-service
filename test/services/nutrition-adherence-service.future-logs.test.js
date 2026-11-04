import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadAdherenceByPatient } from '../../src/services/nutrition-adherence-service.js';
import { MealLogStatus, PlanStatus } from '../../src/constants/nutrition.js';

const NOW = new Date('2026-11-02T15:00:00.000Z');
const TODAY_KEY = new Date('2026-11-02T00:00:00.000Z');
const TOMORROW_KEY = new Date('2026-11-03T00:00:00.000Z');

const plan = {
  id: 'plan-1',
  assigneeId: 'patient-1',
  status: PlanStatus.PUBLISHED,
  firstPublishedAt: new Date('2026-09-01T12:00:00.000Z'),
  publishedSnapshot: { meals: [{ id: 'meal-1', name: 'Café', options: [{ id: 'o1', items: [] }] }] },
};

describe('loadAdherenceByPatient future logs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should not count meals logged after today in mealsDone', async () => {
    const mealLogs = [
      { planId: 'plan-1', mealId: 'meal-1', status: MealLogStatus.DONE, date: TODAY_KEY },
      { planId: 'plan-1', mealId: 'meal-1', status: MealLogStatus.DONE, date: TOMORROW_KEY },
    ];
    const prisma = {
      dietMealLog: { findMany: vi.fn().mockResolvedValue(mealLogs) },
      dietSwapLog: { findMany: vi.fn().mockResolvedValue([]) },
    };

    const result = await loadAdherenceByPatient(prisma, [plan]);

    expect(result.get('patient-1').mealsDone).toBe(1);
  });
});
