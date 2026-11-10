/**
 * Consistency Ranking Routes (trainer)
 *
 * GET    /trainer/consistency-ranking/standings
 * GET    /trainer/consistency-ranking/config
 * PUT    /trainer/consistency-ranking/config
 * POST   /trainer/consistency-ranking/pauses
 * DELETE /trainer/consistency-ranking/pauses
 * POST   /trainer/consistency-ranking/seasons/current/close
 *
 * Auth: authenticate; the trainer profile lookup is the authorization (403 trainer.notFound)
 */

import { ConsistencyErrorCode, ConsistencyMessageCode } from '../../src/constants/consistency-ranking.js';
import { ForbiddenAppError, ValidationAppError } from '../../src/errors/app-error.js';
import { formatDateOnly } from '../../src/helpers/date-helpers.js';
import { authenticate } from '../middleware/auth.js';
import { getConfig, updateConfig } from '../../src/services/consistency-config-service.js';
import { pauseWeek, resumeWeek } from '../../src/services/consistency-pause-service.js';
import { ensureCurrentSeasonLocked, requestEarlyClose } from '../../src/services/consistency-season-service.js';
import { getStandings } from '../../src/services/consistency-standings-service.js';
import {
  closeCurrentSeasonSchema,
  getConfigSchema,
  getStandingsSchema,
  pauseWeekSchema,
  resumeWeekSchema,
  updateConfigSchema,
} from '../schemas/consistency-ranking-route.schema.js';
import { prisma } from '../../src/db.js';

const MONDAY_UTC_DAY = 1;
const WEEK_START_FORMAT = /^(\d{4})-(\d{2})-(\d{2})$/;

// Trainer id of the authenticated user, or 403 trainer.notFound when the user has no trainer profile
async function requireTrainerId(userId) {
  const trainer = await prisma.trainer.findUnique({ where: { userId }, select: { id: true } });
  if (!trainer) {
    throw new ForbiddenAppError({
      error: ConsistencyErrorCode.TRAINER_PROFILE_MISSING,
      messageCode: ConsistencyMessageCode.TRAINER_PROFILE_MISSING,
      message: 'Trainer profile not found',
      details: {},
    });
  }
  return trainer.id;
}

// 400 for a weekStart that is not a real calendar Monday
function invalidWeekStartError(reason) {
  return new ValidationAppError({
    details: [
      {
        field: 'weekStart',
        validations: [reason],
        messageCode: `validation.weekStart.${reason}`,
        message: reason === 'monday' ? 'weekStart must be a Monday' : 'weekStart must be a valid calendar date',
      },
    ],
  });
}

// Civil {year, month, day} of a "YYYY-MM-DD" Monday; throws the 400 for impossible dates and non-Mondays
function parseWeekStart(value) {
  const match = WEEK_START_FORMAT.exec(value);
  if (!match) throw invalidWeekStartError('date');
  const civil = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const probe = new Date(Date.UTC(civil.year, civil.month - 1, civil.day));
  const isReal = probe.getUTCFullYear() === civil.year && probe.getUTCMonth() + 1 === civil.month && probe.getUTCDate() === civil.day;
  if (!isReal) throw invalidWeekStartError('date');
  if (probe.getUTCDay() !== MONDAY_UTC_DAY) throw invalidWeekStartError('monday');
  return civil;
}

// Decimal (or null) to a JSON number (or null)
function toNumberOrNull(decimal) {
  return decimal === null || decimal === undefined ? null : decimal.toNumber();
}

// Standings row with the Decimal figures converted to numbers (partialScore stays absent on frozen rows)
function serializeRow(row) {
  const converted = { ...row, average: toNumberOrNull(row.average) };
  if ('partialScore' in row) converted.partialScore = toNumberOrNull(row.partialScore);
  return converted;
}

// Season summary returned by the early-close route
function serializeClosedRequest(season) {
  return {
    number: season.number,
    startWeek: formatDateOnly(season.startWeek),
    weeks: season.weeks,
    status: season.status,
    closeRequestedAt: season.closeRequestedAt,
  };
}

// Standings payload of a trainer's team (current season, or the frozen one when seasonNumber is given), JSON-ready
export async function buildStandingsPayload(trainerId, seasonNumber) {
  const now = new Date();
  if (seasonNumber === undefined) await ensureCurrentSeasonLocked(prisma, trainerId, now);
  const standings = await getStandings(prisma, trainerId, { seasonNumber, now });
  return { ...standings, rows: standings.rows.map(serializeRow) };
}

// Route plugin registering the trainer consistency ranking endpoints
export async function consistencyRankingRoutes(fastify) {
  const preHandler = [authenticate];

  fastify.get('/trainer/consistency-ranking/standings', { preHandler, schema: getStandingsSchema }, async (request, reply) => {
    const trainerId = await requireTrainerId(request.user.id);
    return reply.send(await buildStandingsPayload(trainerId, request.query.season));
  });

  fastify.get('/trainer/consistency-ranking/config', { preHandler, schema: getConfigSchema }, async (request, reply) => {
    const trainerId = await requireTrainerId(request.user.id);
    return reply.send(await getConfig(prisma, trainerId, new Date()));
  });

  fastify.put('/trainer/consistency-ranking/config', { preHandler, schema: updateConfigSchema }, async (request, reply) => {
    const trainerId = await requireTrainerId(request.user.id);
    return reply.send(await updateConfig(prisma, trainerId, request.body, new Date()));
  });

  fastify.post('/trainer/consistency-ranking/pauses', { preHandler, schema: pauseWeekSchema }, async (request, reply) => {
    const trainerId = await requireTrainerId(request.user.id);
    const { weekStart, studentId, reason } = request.body;
    const result = await pauseWeek(prisma, trainerId, { weekStart: parseWeekStart(weekStart), studentId, reason }, new Date());
    return reply.send(result);
  });

  fastify.delete('/trainer/consistency-ranking/pauses', { preHandler, schema: resumeWeekSchema }, async (request, reply) => {
    const trainerId = await requireTrainerId(request.user.id);
    const { weekStart, studentId } = request.body;
    const result = await resumeWeek(prisma, trainerId, { weekStart: parseWeekStart(weekStart), studentId }, new Date());
    return reply.send(result);
  });

  fastify.post('/trainer/consistency-ranking/seasons/current/close', { preHandler, schema: closeCurrentSeasonSchema }, async (request, reply) => {
    const trainerId = await requireTrainerId(request.user.id);
    const season = await requestEarlyClose(prisma, trainerId, new Date());
    return reply.send(serializeClosedRequest(season));
  });
}
