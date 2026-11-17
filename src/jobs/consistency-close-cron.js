/**
 * Consistency ranking close cron job — prepares the current week, closes finished weeks, then closes the weekly championships whose last week closed.
 *
 * Schedule: every 15 minutes, UTC (each trainer's week ends at their own local midnight,
 * so closing is driven by "due" weeks, not by a single clock time).
 * Enabled: NODE_ENV=production OR ENABLE_CONSISTENCY_RANKING_CRON=true.
 *          Intentionally disabled in test runs and local dev by default.
 */

import cron from 'node-cron';
import { closeDueChallenges } from '../services/challenge-close-service.js';
import { closeDueWeeks, prepareCurrentWeek } from '../services/consistency-close-service.js';

const CONSISTENCY_CLOSE_CRON_EXPRESSION = '*/15 * * * *';

/**
 * Schedules the 15-minute prepare-and-close tick.
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {object} logger - Fastify logger (or compatible pino instance)
 * @returns {import('node-cron').ScheduledTask}
 */
export function startConsistencyCloseCron(prisma, logger) {
  return cron.schedule(
    CONSISTENCY_CLOSE_CRON_EXPRESSION,
    async () => {
      const now = new Date();
      try {
        await prepareCurrentWeek(prisma, now, logger);
      } catch (err) {
        logger.error({ err }, '[cron:consistency-close] prepareCurrentWeek failed');
      }
      try {
        await closeDueWeeks(prisma, logger, now);
      } catch (err) {
        logger.error({ err }, '[cron:consistency-close] closeDueWeeks failed');
      }
      try {
        await closeDueChallenges(prisma, logger, now);
      } catch (err) {
        logger.error({ err }, '[cron:consistency-close] closeDueChallenges failed');
      }
    },
    { timezone: 'UTC' },
  );
}
