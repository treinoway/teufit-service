import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node-cron', () => ({ default: { schedule: vi.fn() } }));
vi.mock('../../src/services/student-feedback-scheduler-service.js', () => ({
  expireOverdueFeedbacks: vi.fn(),
  sendDueFeedbacks: vi.fn(),
  sendDueReminders: vi.fn(),
}));

import cron from 'node-cron';
import { startStudentFeedbackCron } from '../../src/jobs/student-feedback-cron.js';
import {
  expireOverdueFeedbacks,
  sendDueFeedbacks,
  sendDueReminders,
} from '../../src/services/student-feedback-scheduler-service.js';

const EVERY_15_MINUTES = '*/15 * * * *';
const NOW = new Date('2026-11-08T12:00:00Z');

const prisma = { marker: 'prisma' };
const emailSender = { marker: 'email-sender' };
const logger = { info: vi.fn(), error: vi.fn() };

// Runs the callback the job handed to node-cron, as a tick would.
async function runScheduledTask() {
  const [, task] = cron.schedule.mock.calls[0];
  await task();
}

describe('startStudentFeedbackCron', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it('schedules the job every 15 minutes in UTC', () => {
    startStudentFeedbackCron(prisma, logger, emailSender);

    expect(cron.schedule).toHaveBeenCalledWith(EVERY_15_MINUTES, expect.any(Function), { timezone: 'UTC' });
  });

  it('returns the scheduled task', () => {
    const task = { marker: 'task' };
    cron.schedule.mockReturnValue(task);

    expect(startStudentFeedbackCron(prisma, logger, emailSender)).toBe(task);
  });

  it('expires overdue requests, sends the due ones, then the reminders, at the tick time', async () => {
    const order = [];
    expireOverdueFeedbacks.mockImplementation(async () => order.push('expire'));
    sendDueFeedbacks.mockImplementation(async () => order.push('send'));
    sendDueReminders.mockImplementation(async () => order.push('remind'));
    startStudentFeedbackCron(prisma, logger, emailSender);

    await runScheduledTask();

    expect(expireOverdueFeedbacks).toHaveBeenCalledWith(prisma, NOW);
    expect(sendDueFeedbacks).toHaveBeenCalledWith(prisma, emailSender, logger, NOW);
    expect(sendDueReminders).toHaveBeenCalledWith(prisma, emailSender, logger, NOW);
    expect(order).toEqual(['expire', 'send', 'remind']);
  });

  it('logs an expireOverdueFeedbacks failure and still sends', async () => {
    const failure = new Error('expire down');
    expireOverdueFeedbacks.mockRejectedValue(failure);
    startStudentFeedbackCron(prisma, logger, emailSender);

    await expect(runScheduledTask()).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith({ err: failure }, expect.any(String));
    expect(sendDueFeedbacks).toHaveBeenCalledWith(prisma, emailSender, logger, NOW);
    expect(sendDueReminders).toHaveBeenCalledWith(prisma, emailSender, logger, NOW);
  });

  it('logs a sendDueFeedbacks failure and still sends the reminders', async () => {
    const failure = new Error('send down');
    sendDueFeedbacks.mockRejectedValue(failure);
    startStudentFeedbackCron(prisma, logger, emailSender);

    await expect(runScheduledTask()).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith({ err: failure }, expect.any(String));
    expect(sendDueReminders).toHaveBeenCalledWith(prisma, emailSender, logger, NOW);
  });

  it('logs a sendDueReminders failure without crashing the tick', async () => {
    const failure = new Error('remind down');
    sendDueReminders.mockRejectedValue(failure);
    startStudentFeedbackCron(prisma, logger, emailSender);

    await expect(runScheduledTask()).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith({ err: failure }, expect.any(String));
  });
});
