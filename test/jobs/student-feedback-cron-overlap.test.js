import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const prisma = { marker: 'prisma' };
const emailSender = { marker: 'email-sender' };

// Starts the job and returns the tick callback it handed to node-cron
function startAndGetTick(logger) {
  startStudentFeedbackCron(prisma, logger, emailSender);
  const [, tick] = cron.schedule.mock.calls.at(-1);
  return tick;
}

// Makes the first step of the tick hang until the returned function is called
function holdFirstStep() {
  let release = null;
  expireOverdueFeedbacks.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  return () => release();
}

describe('startStudentFeedbackCron overlap guard', () => {
  let logger;

  beforeEach(() => {
    vi.resetAllMocks();
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  });

  it('skips a tick that starts while the previous one still runs', async () => {
    const release = holdFirstStep();
    const tick = startAndGetTick(logger);
    const running = tick();

    await tick();

    expect(expireOverdueFeedbacks).toHaveBeenCalledTimes(1);
    expect(sendDueFeedbacks).not.toHaveBeenCalled();
    expect(sendDueReminders).not.toHaveBeenCalled();
    release();
    await running;
  });

  it('warns once through logger.warn about the skipped tick', async () => {
    const release = holdFirstStep();
    const tick = startAndGetTick(logger);
    const running = tick();

    await tick();

    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('skipped'));
    expect(logger.error).not.toHaveBeenCalled();
    release();
    await running;
  });

  it('lets the running tick finish its three steps after an overlapping one was skipped', async () => {
    const release = holdFirstStep();
    const tick = startAndGetTick(logger);
    const running = tick();
    await tick();

    release();
    await running;

    expect(sendDueFeedbacks).toHaveBeenCalledTimes(1);
    expect(sendDueReminders).toHaveBeenCalledTimes(1);
  });

  it('runs the next tick normally once the previous one finished', async () => {
    const tick = startAndGetTick(logger);
    await tick();

    await tick();

    expect(expireOverdueFeedbacks).toHaveBeenCalledTimes(2);
    expect(sendDueFeedbacks).toHaveBeenCalledTimes(2);
    expect(sendDueReminders).toHaveBeenCalledTimes(2);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('runs again after an overlapping tick was skipped and the first one finished', async () => {
    const release = holdFirstStep();
    const tick = startAndGetTick(logger);
    const running = tick();
    await tick();
    release();
    await running;

    await tick();

    expect(expireOverdueFeedbacks).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('releases the guard when a tick whose steps all failed ends', async () => {
    expireOverdueFeedbacks.mockRejectedValueOnce(new TypeError('expire down'));
    sendDueFeedbacks.mockRejectedValueOnce(new TypeError('send down'));
    sendDueReminders.mockRejectedValueOnce(new TypeError('remind down'));
    const tick = startAndGetTick(logger);
    await tick();

    await tick();

    expect(expireOverdueFeedbacks).toHaveBeenCalledTimes(2);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('releases the guard even when the tick itself throws', async () => {
    const failure = new TypeError('logger down');
    expireOverdueFeedbacks.mockRejectedValueOnce(new TypeError('expire down'));
    logger.error.mockImplementationOnce(() => {
      throw failure;
    });
    const tick = startAndGetTick(logger);
    await expect(tick()).rejects.toBe(failure);

    await tick();

    expect(sendDueFeedbacks).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('keeps one guard per started job', async () => {
    const release = holdFirstStep();
    const firstJobTick = startAndGetTick(logger);
    const otherLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const otherJobTick = startAndGetTick(otherLogger);
    const running = firstJobTick();

    await otherJobTick();

    expect(otherLogger.warn).not.toHaveBeenCalled();
    expect(sendDueFeedbacks).toHaveBeenCalledTimes(1);
    release();
    await running;
  });
});
