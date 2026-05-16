/**
 * Briefing cron job — daily trainer briefing snapshot refresh.
 *
 * Schedule: 22:00 UTC every day.
 * Enabled: NODE_ENV=production OR ENABLE_BRIEFING_CRON=true.
 *          Intentionally disabled in test runs and local dev by default.
 *
 * TODO(scaling): if running multiple instances, gate this with a
 * leader-election or DB advisory lock so only one instance runs the cron.
 */

import cron from 'node-cron';
import * as briefingService from '../services/briefing-service.js';

/**
 * Start the daily briefing cron task.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {object} logger - Fastify logger (or compatible pino instance)
 * @returns {import('node-cron').ScheduledTask}
 */
export function startBriefingCron(prisma, logger) {
  const task = cron.schedule(
    '0 22 * * *',
    async () => {
      logger.info('[cron:briefing] starting daily refresh');
      try {
        await briefingService.refreshAllBriefings(prisma, logger);
        logger.info('[cron:briefing] finished');
      } catch (err) {
        logger.error({ err }, '[cron:briefing] failed');
      }
    },
    { timezone: 'UTC' },
  );

  return task;
}
