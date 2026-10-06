import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node-cron', () => ({ default: { schedule: vi.fn() } }));
vi.mock('../../src/services/subscription-cycle-service.js', () => ({
  ensureUpcomingCycles: vi.fn(),
}));

import cron from 'node-cron';
import { startSubscriptionCycleCron } from '../../src/jobs/subscription-cycle-cron.js';
import { ensureUpcomingCycles } from '../../src/services/subscription-cycle-service.js';
import { BUSINESS_TIMEZONE } from '../../src/constants/subscription.js';

const DAILY_AT_3AM = '0 3 * * *';

const prisma = { marker: 'prisma' };
const logger = { info: vi.fn(), error: vi.fn() };

async function runScheduledTask() {
  const [, task] = cron.schedule.mock.calls[0];
  await task();
}

describe('startSubscriptionCycleCron', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useRealTimers();
  });

  it('schedules the generation daily at 03:00 in the business timezone', () => {
    startSubscriptionCycleCron(prisma, logger);

    expect(cron.schedule).toHaveBeenCalledWith(DAILY_AT_3AM, expect.any(Function), {
      timezone: BUSINESS_TIMEZONE,
    });
  });

  it('runs ensureUpcomingCycles for ALL trainers (no trainerId) with the Sao Paulo civil day', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T06:00:00Z'));
    ensureUpcomingCycles.mockResolvedValue({ subscriptionsChecked: 2, cyclesCreated: 3 });
    startSubscriptionCycleCron(prisma, logger);

    await runScheduledTask();

    expect(ensureUpcomingCycles).toHaveBeenCalledWith(prisma, {
      today: new Date('2026-06-10T00:00:00Z'),
    });
    expect(logger.info).toHaveBeenCalledWith(
      { subscriptionsChecked: 2, cyclesCreated: 3 },
      expect.any(String),
    );
  });

  it('logs and swallows generation failures so the scheduler keeps running', async () => {
    const failure = new Error('db down');
    ensureUpcomingCycles.mockRejectedValue(failure);
    startSubscriptionCycleCron(prisma, logger);

    await expect(runScheduledTask()).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith({ err: failure }, expect.any(String));
  });
});
