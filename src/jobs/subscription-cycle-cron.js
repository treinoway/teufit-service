/**
 * Subscription cycle cron job — daily generation of upcoming billing cycles.
 *
 * Schedule: 03:00 America/Sao_Paulo every day (catch-up covers missed days).
 * Enabled: NODE_ENV=production OR ENABLE_SUBSCRIPTION_CYCLE_CRON=true.
 *          Intentionally disabled in test runs and local dev by default.
 *
 * Safe with multiple instances: generation is idempotent
 * (@@unique([subscriptionId, cycleIndex]) + INSERT ... ON CONFLICT DO NOTHING).
 */

import cron from 'node-cron';
import { BUSINESS_TIMEZONE } from '../constants/subscription.js';
import { todayInBusinessTz } from '../helpers/date-helpers.js';
import { ensureUpcomingCycles } from '../services/subscription-cycle-service.js';

const SUBSCRIPTION_CYCLE_CRON_EXPRESSION = '0 3 * * *';

/**
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {object} logger - Fastify logger (or compatible pino instance)
 * @returns {import('node-cron').ScheduledTask}
 */
export function startSubscriptionCycleCron(prisma, logger) {
  return cron.schedule(
    SUBSCRIPTION_CYCLE_CRON_EXPRESSION,
    async () => {
      logger.info('[cron:subscription-cycles] starting daily generation');
      try {
        const summary = await ensureUpcomingCycles(prisma, { today: todayInBusinessTz() });
        logger.info(summary, '[cron:subscription-cycles] finished');
      } catch (err) {
        logger.error({ err }, '[cron:subscription-cycles] failed');
      }
    },
    { timezone: BUSINESS_TIMEZONE },
  );
}
