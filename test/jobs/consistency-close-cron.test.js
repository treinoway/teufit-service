import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node-cron', () => ({ default: { schedule: vi.fn() } }));
vi.mock('../../src/services/consistency-close-service.js', () => ({
  prepareCurrentWeek: vi.fn(),
  closeDueWeeks: vi.fn(),
}));
vi.mock('../../src/services/challenge-close-service.js', () => ({
  closeDueChallenges: vi.fn(),
}));

import cron from 'node-cron';
import { startConsistencyCloseCron } from '../../src/jobs/consistency-close-cron.js';
import {
  prepareCurrentWeek,
  closeDueWeeks,
} from '../../src/services/consistency-close-service.js';
import { closeDueChallenges } from '../../src/services/challenge-close-service.js';

const EVERY_15_MINUTES = '*/15 * * * *';
const NOW = new Date('2026-06-15T03:15:00Z');

const prisma = { marker: 'prisma' };
const logger = { info: vi.fn(), error: vi.fn() };

// Runs the callback the job handed to node-cron, as a tick would.
async function runScheduledTask() {
  const [, task] = cron.schedule.mock.calls[0];
  await task();
}

describe('startConsistencyCloseCron', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it('schedules the job every 15 minutes in UTC', () => {
    startConsistencyCloseCron(prisma, logger);

    expect(cron.schedule).toHaveBeenCalledWith(EVERY_15_MINUTES, expect.any(Function), {
      timezone: 'UTC',
    });
  });

  it('returns the scheduled task', () => {
    const task = { marker: 'task' };
    cron.schedule.mockReturnValue(task);

    expect(startConsistencyCloseCron(prisma, logger)).toBe(task);
  });

  it('prepares the current week with the logger, then closes due weeks, at the tick time', async () => {
    const order = [];
    prepareCurrentWeek.mockImplementation(async () => order.push('prepare'));
    closeDueWeeks.mockImplementation(async () => order.push('close'));
    startConsistencyCloseCron(prisma, logger);

    await runScheduledTask();

    expect(prepareCurrentWeek).toHaveBeenCalledWith(prisma, NOW, logger);
    expect(closeDueWeeks).toHaveBeenCalledWith(prisma, logger, NOW);
    expect(order).toEqual(['prepare', 'close']);
  });

  it('logs a prepareCurrentWeek failure and still closes due weeks', async () => {
    const failure = new Error('prepare down');
    prepareCurrentWeek.mockRejectedValue(failure);
    startConsistencyCloseCron(prisma, logger);

    await expect(runScheduledTask()).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith({ err: failure }, expect.any(String));
    expect(closeDueWeeks).toHaveBeenCalledWith(prisma, logger, NOW);
  });

  it('logs a closeDueWeeks failure without crashing the tick', async () => {
    const failure = new Error('close down');
    closeDueWeeks.mockRejectedValue(failure);
    startConsistencyCloseCron(prisma, logger);

    await expect(runScheduledTask()).resolves.toBeUndefined();

    expect(prepareCurrentWeek).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith({ err: failure }, expect.any(String));
  });

  it('CAMP-32 closes the due championships after closing the weeks, at the tick time', async () => {
    const order = [];
    prepareCurrentWeek.mockImplementation(async () => order.push('prepare'));
    closeDueWeeks.mockImplementation(async () => order.push('weeks'));
    closeDueChallenges.mockImplementation(async () => order.push('championships'));
    startConsistencyCloseCron(prisma, logger);

    await runScheduledTask();

    expect(closeDueChallenges).toHaveBeenCalledWith(prisma, logger, NOW);
    expect(order).toEqual(['prepare', 'weeks', 'championships']);
  });

  it('CAMP-32 still closes the championships when closing the weeks fails', async () => {
    const failure = new Error('close down');
    closeDueWeeks.mockRejectedValue(failure);
    startConsistencyCloseCron(prisma, logger);

    await runScheduledTask();

    expect(logger.error).toHaveBeenCalledWith({ err: failure }, expect.stringContaining('closeDueWeeks'));
    expect(closeDueChallenges).toHaveBeenCalledWith(prisma, logger, NOW);
  });

  it('CAMP-35 logs a closeDueChallenges failure without crashing the tick', async () => {
    const failure = new Error('championships down');
    closeDueChallenges.mockRejectedValue(failure);
    startConsistencyCloseCron(prisma, logger);

    await expect(runScheduledTask()).resolves.toBeUndefined();

    expect(closeDueWeeks).toHaveBeenCalledWith(prisma, logger, NOW);
    expect(logger.error).toHaveBeenCalledWith({ err: failure }, expect.stringContaining('closeDueChallenges'));
  });
});
