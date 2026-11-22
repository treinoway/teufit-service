/**
 * Student feedback cron job — expires the overdue requests, sends the due milestones, then the reminders.
 *
 * Schedule: every 15 minutes, UTC (milestones fall due at 09:00 America/Sao_Paulo; sending is driven by
 * "due" requests, so a late tick still sends).
 * Enabled: NODE_ENV=production OR ENABLE_STUDENT_FEEDBACK_CRON=true.
 *          Intentionally disabled in test runs and local dev by default.
 * Safe with multiple instances: sends take an advisory lock per trainer-student pair and reminders are claimed atomically.
 * Ticks of one process never overlap: a tick that starts while the previous one still runs is skipped.
 */

import cron from 'node-cron';
import { expireOverdueFeedbacks, sendDueFeedbacks, sendDueReminders } from '../services/student-feedback-scheduler-service.js';

const STUDENT_FEEDBACK_CRON_EXPRESSION = '*/15 * * * *';

// Runs one expire-send-remind tick; a failing step is logged and never stops the next ones
async function runTick(prisma, logger, emailSender) {
  const now = new Date();
  try {
    await expireOverdueFeedbacks(prisma, now);
  } catch (err) {
    logger.error({ err }, '[cron:student-feedback] expireOverdueFeedbacks failed');
  }
  try {
    await sendDueFeedbacks(prisma, emailSender, logger, now);
  } catch (err) {
    logger.error({ err }, '[cron:student-feedback] sendDueFeedbacks failed');
  }
  try {
    await sendDueReminders(prisma, emailSender, logger, now);
  } catch (err) {
    logger.error({ err }, '[cron:student-feedback] sendDueReminders failed');
  }
}

/**
 * Schedules the 15-minute expire-send-remind tick; a tick that starts while the previous one of this process still runs is skipped.
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {object} logger - Fastify logger (or compatible pino instance)
 * @param {object} emailSender - e-mail handler with the student feedback senders
 * @returns {import('node-cron').ScheduledTask}
 */
export function startStudentFeedbackCron(prisma, logger, emailSender) {
  let tickRunning = false;
  return cron.schedule(
    STUDENT_FEEDBACK_CRON_EXPRESSION,
    async () => {
      if (tickRunning) {
        logger.warn('[cron:student-feedback] previous tick still running; tick skipped');
        return;
      }
      tickRunning = true;
      try {
        await runTick(prisma, logger, emailSender);
      } finally {
        tickRunning = false;
      }
    },
    { timezone: 'UTC' },
  );
}
