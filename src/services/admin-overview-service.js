import { Prisma } from '@prisma/client';
import { BUSINESS_TIMEZONE } from '../constants/subscription.js';
import { WorkoutSessionStatus } from '../constants/training.js';
import { InviteStatus } from '../constants/trainer-invite.js';
import { FEEDBACK_STATUSES } from '../constants/feedback.js';
import { PLATFORM_PLAN_TIERS, PLATFORM_PLAN_TIER_ORDER, getBillingMonth } from '../constants/platform-plan.js';
import { AI_MODEL_PRICES_USD_PER_MTOK } from '../constants/ai-pricing.js';
import {
  OVERVIEW_DEFAULT_PERIOD,
  OVERVIEW_LATEST_TRAINERS_LIMIT,
  OVERVIEW_NO_STUDENT_THRESHOLD_DAYS,
  OVERVIEW_TOP_AI_TRAINERS_LIMIT,
} from '../constants/admin-manager.js';
import { overviewPeriodWindows, overviewWeekStarts, estimateAiCostUsd } from '../helpers/admin-overview.js';
import { zonedWallClockToInstant } from '../helpers/date-helpers.js';

const MS_PER_DAY = 86_400_000;
const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
const LIVE_TRAINER = Prisma.sql`t.deleted_at IS NULL AND u.deleted_at IS NULL`;
const HAS_LIVE_STUDENT = Prisma.sql`EXISTS (
  SELECT 1 FROM trainer_students ts JOIN users su ON su.id = ts.student_id
  WHERE ts.trainer_id = t.id AND su.deleted_at IS NULL
)`;
const IS_LIVE_STUDENT = Prisma.sql`u.deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM trainer_students ts WHERE ts.student_id = u.id)
  AND NOT EXISTS (SELECT 1 FROM trainers st WHERE st.user_id = u.id)`;

// Builds a SQL predicate for a timestamp column inside [from, to).
function inWindow(column, from, to) {
  return Prisma.sql`${column} >= ${from}::timestamptz AND ${column} < ${to}::timestamptz`;
}

// Counts live trainers per stored tier with new-trainer and no-student counts (null tier = no subscription row).
function queryTrainerTierStats(adminDb, { windows, noStudentCutoff }) {
  const createdAt = Prisma.sql`t.created_at`;
  return adminDb.$queryRaw`
    SELECT
      ps.tier::text AS tier,
      COUNT(*)::int AS trainers,
      COUNT(*) FILTER (WHERE ${inWindow(createdAt, windows.from, windows.to)})::int AS new_current,
      COUNT(*) FILTER (WHERE ${inWindow(createdAt, windows.previousFrom, windows.previousTo)})::int AS new_previous,
      COUNT(*) FILTER (WHERE t.created_at < ${noStudentCutoff}::timestamptz AND NOT ${HAS_LIVE_STUDENT})::int AS without_students
    FROM trainers t
    JOIN users u ON u.id = t.user_id
    LEFT JOIN platform_subscriptions ps ON ps.trainer_id = t.id
    WHERE ${LIVE_TRAINER}
    GROUP BY ps.tier
  `;
}

// Counts new students in the current and previous windows.
function queryNewStudents(adminDb, { windows }) {
  const createdAt = Prisma.sql`u.created_at`;
  return adminDb.$queryRaw`
    SELECT
      COUNT(*) FILTER (WHERE ${inWindow(createdAt, windows.from, windows.to)})::int AS current,
      COUNT(*) FILTER (WHERE ${inWindow(createdAt, windows.previousFrom, windows.previousTo)})::int AS previous
    FROM users u
    WHERE ${IS_LIVE_STUDENT} AND ${inWindow(createdAt, windows.previousFrom, windows.to)}
  `;
}

// Counts trainer and student signups per business-timezone week since the first week start.
function queryWeeklySignups(adminDb, { weeksFrom, to }) {
  return adminDb.$queryRaw`
    SELECT to_char(date_trunc('week', t.created_at AT TIME ZONE ${BUSINESS_TIMEZONE}::text), 'YYYY-MM-DD') AS week_start,
      COUNT(*)::int AS trainers, 0 AS students
    FROM trainers t
    JOIN users u ON u.id = t.user_id
    WHERE ${LIVE_TRAINER} AND ${inWindow(Prisma.sql`t.created_at`, weeksFrom, to)}
    GROUP BY 1
    UNION ALL
    SELECT to_char(date_trunc('week', u.created_at AT TIME ZONE ${BUSINESS_TIMEZONE}::text), 'YYYY-MM-DD') AS week_start,
      0 AS trainers, COUNT(*)::int AS students
    FROM users u
    WHERE ${IS_LIVE_STUDENT} AND ${inWindow(Prisma.sql`u.created_at`, weeksFrom, to)}
    GROUP BY 1
  `;
}

// Counts completed sessions and distinct live owning trainers with student sessions (own sessions excluded) in the current and previous windows.
function querySessionStats(adminDb, { windows }) {
  const finishedAt = Prisma.sql`ws.finished_at`;
  const current = inWindow(finishedAt, windows.from, windows.to);
  const previous = inWindow(finishedAt, windows.previousFrom, windows.previousTo);
  return adminDb.$queryRaw`
    SELECT
      COUNT(*) FILTER (WHERE ${current})::int AS sessions_current,
      COUNT(*) FILTER (WHERE ${previous})::int AS sessions_previous,
      COUNT(DISTINCT t.id) FILTER (WHERE ${current} AND ${LIVE_TRAINER} AND ws.user_id <> t.user_id)::int AS trainers_current,
      COUNT(DISTINCT t.id) FILTER (WHERE ${previous} AND ${LIVE_TRAINER} AND ws.user_id <> t.user_id)::int AS trainers_previous
    FROM workout_sessions ws
    JOIN trainings tr ON tr.id = ws.training_id
    JOIN training_protocols tp ON tp.id = tr.training_protocol_id
    JOIN trainers t ON t.id = tp.trainer_id
    JOIN users u ON u.id = t.user_id
    WHERE ws.status = ${WorkoutSessionStatus.COMPLETED}
      AND ws.deleted_at IS NULL
      AND ${inWindow(finishedAt, windows.previousFrom, windows.to)}
  `;
}

// Sums the billing month's token usage per trainer and model, with the trainer's name, email and stored tier.
function queryAiUsageByTrainerModel(adminDb, { billingMonth }) {
  return adminDb.$queryRaw`
    SELECT
      ai.trainer_id, ai.model, u.first_name, u.last_name, u.email, ps.tier::text AS tier,
      SUM(ai.input_tokens)::bigint AS input_tokens,
      SUM(ai.output_tokens)::bigint AS output_tokens,
      SUM(ai.cache_read_tokens)::bigint AS cache_read_tokens,
      SUM(ai.cache_write_tokens)::bigint AS cache_write_tokens,
      COUNT(*)::int AS interactions
    FROM ai_token_usage ai
    JOIN trainers t ON t.id = ai.trainer_id
    JOIN users u ON u.id = t.user_id
    LEFT JOIN platform_subscriptions ps ON ps.trainer_id = t.id
    WHERE ai.billing_month = ${billingMonth}
    GROUP BY ai.trainer_id, ai.model, u.first_name, u.last_name, u.email, ps.tier
  `;
}

// Lists the newest live trainers with stored tier and live student count.
function queryLatestTrainers(adminDb) {
  return adminDb.$queryRaw`
    SELECT
      u.id AS user_id, u.first_name, u.last_name, u.email, t.created_at, ps.tier::text AS tier,
      (SELECT COUNT(*) FROM trainer_students ts JOIN users su ON su.id = ts.student_id
        WHERE ts.trainer_id = t.id AND su.deleted_at IS NULL)::int AS student_count
    FROM trainers t
    JOIN users u ON u.id = t.user_id
    LEFT JOIN platform_subscriptions ps ON ps.trainer_id = t.id
    WHERE ${LIVE_TRAINER}
    ORDER BY t.created_at DESC, t.id ASC
    LIMIT ${OVERVIEW_LATEST_TRAINERS_LIMIT}::int
  `;
}

/**
 * Counts unexpired pending trainer invites (accepted wins: emails already a live trainer are left out) and NEW trainer feedbacks in one query.
 *
 * @param {object} adminDb - read-only admin Prisma client
 * @returns {Promise<{ pendingInvites: number, newFeedbacks: number }>}
 */
export async function countPendingItems(adminDb) {
  const [row] = await adminDb.$queryRaw`
    SELECT
      (SELECT COUNT(*) FROM trainer_invites ti
        WHERE ti.status = ${InviteStatus.PENDING} AND ti.expires_at > now()
          AND NOT EXISTS (
            SELECT 1 FROM users u JOIN trainers t ON t.user_id = u.id
            WHERE lower(u.email) = lower(ti.email) AND ${LIVE_TRAINER}
          ))::int AS pending_invites,
      (SELECT COUNT(*) FROM trainer_feedbacks
        WHERE status = ${FEEDBACK_STATUSES.NEW}::"FeedbackStatus")::int AS new_feedbacks
  `;
  return { pendingInvites: row.pending_invites, newFeedbacks: row.new_feedbacks };
}

// Reads a stored tier, treating a missing subscription row as FREE.
function toTier(storedTier) {
  return storedTier ?? PLATFORM_PLAN_TIERS.FREE;
}

// Folds the per-tier rows into plan counts (enum order), new-trainer KPI and trainers without students.
function summarizeTrainerTiers(rows) {
  const countsByTier = new Map(PLATFORM_PLAN_TIER_ORDER.map((tier) => [tier, 0]));
  const summary = { newTrainers: { current: 0, previous: 0 }, trainersWithoutStudents: 0 };
  for (const row of rows) {
    const tier = toTier(row.tier);
    countsByTier.set(tier, countsByTier.get(tier) + row.trainers);
    summary.newTrainers.current += row.new_current;
    summary.newTrainers.previous += row.new_previous;
    summary.trainersWithoutStudents += row.without_students;
  }
  return { ...summary, plans: PLATFORM_PLAN_TIER_ORDER.map((tier) => ({ tier, count: countsByTier.get(tier) })) };
}

// Places weekly signup rows into the fixed list of week starts (missing weeks are zero).
function toWeeklySignups(weekStarts, rows) {
  const buckets = new Map(weekStarts.map((weekStart) => [weekStart, { weekStart, trainers: 0, students: 0 }]));
  for (const row of rows) {
    const bucket = buckets.get(row.week_start);
    if (!bucket) continue;
    bucket.trainers += Number(row.trainers);
    bucket.students += Number(row.students);
  }
  return [...buckets.values()];
}

// Maps a raw AI usage row to a per-model token counter.
function toTokenCounter(row) {
  return {
    model: row.model,
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    cacheReadTokens: Number(row.cache_read_tokens),
    cacheWriteTokens: Number(row.cache_write_tokens),
  };
}

// Sums the four token fields of the counters.
function sumTokenFields(counters) {
  return Object.fromEntries(TOKEN_FIELDS.map((field) => [field, counters.reduce((sum, counter) => sum + counter[field], 0)]));
}

// Returns the total tokens of a token-field summary.
function totalTokensOf(tokenFields) {
  return TOKEN_FIELDS.reduce((sum, field) => sum + tokenFields[field], 0);
}

// Groups AI usage rows by trainer into ranked top-trainer entries (totalTokens desc, trainerId asc).
function rankAiTrainers(rows) {
  const rowsByTrainer = Map.groupBy(rows, (row) => row.trainer_id);
  const ranked = [...rowsByTrainer.entries()].map(([trainerId, trainerRows]) => {
    const counters = trainerRows.map(toTokenCounter);
    const [first] = trainerRows;
    return {
      trainerId,
      firstName: first.first_name,
      lastName: first.last_name,
      email: first.email,
      tier: toTier(first.tier),
      totalTokens: totalTokensOf(sumTokenFields(counters)),
      estimatedCostUsd: estimateAiCostUsd(counters, AI_MODEL_PRICES_USD_PER_MTOK).estimatedCostUsd,
    };
  });
  ranked.sort((left, right) => (right.totalTokens - left.totalTokens) || left.trainerId.localeCompare(right.trainerId));
  return ranked.slice(0, OVERVIEW_TOP_AI_TRAINERS_LIMIT);
}

// Builds the iArnold block for the billing month from per-trainer, per-model usage rows.
function summarizeAiUsage(billingMonth, rows) {
  const counters = rows.map(toTokenCounter);
  const tokenFields = sumTokenFields(counters);
  return {
    month: billingMonth,
    ...tokenFields,
    totalTokens: totalTokensOf(tokenFields),
    interactions: rows.reduce((sum, row) => sum + row.interactions, 0),
    trainers: new Set(rows.map((row) => row.trainer_id)).size,
    ...estimateAiCostUsd(counters, AI_MODEL_PRICES_USD_PER_MTOK),
    topTrainers: rankAiTrainers(rows),
  };
}

// Maps a latest-trainer row to the API item.
function toLatestTrainer(row) {
  return {
    userId: row.user_id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    tier: toTier(row.tier),
    studentCount: row.student_count,
    createdAt: row.created_at,
  };
}

// Resolves the instants and keys every overview query is filtered by.
function buildOverviewContext(now, period) {
  const weekStarts = overviewWeekStarts(now);
  const [year, month, day] = weekStarts[0].split('-').map(Number);
  return {
    now,
    windows: overviewPeriodWindows(now, period),
    weekStarts,
    weeksFrom: zonedWallClockToInstant({ year, month, day }, BUSINESS_TIMEZONE),
    noStudentCutoff: new Date(now.getTime() - OVERVIEW_NO_STUDENT_THRESHOLD_DAYS * MS_PER_DAY),
    billingMonth: getBillingMonth(now),
  };
}

// Runs the overview queries in pairs so the 2-connection admin pool is never queued deep.
async function runOverviewQueries(adminDb, context) {
  const [tierRows, [studentRow]] = await Promise.all([
    queryTrainerTierStats(adminDb, context),
    queryNewStudents(adminDb, context),
  ]);
  const [weeklyRows, [sessionRow]] = await Promise.all([
    queryWeeklySignups(adminDb, { weeksFrom: context.weeksFrom, to: context.now }),
    querySessionStats(adminDb, context),
  ]);
  const [aiRows, latestRows] = await Promise.all([
    queryAiUsageByTrainerModel(adminDb, context),
    queryLatestTrainers(adminDb),
  ]);
  const pendingItems = await countPendingItems(adminDb);
  return { tierRows, studentRow, weeklyRows, sessionRow, aiRows, latestRows, pendingItems };
}

/**
 * Builds the manager dashboard overview for the period (KPIs vs previous period, weekly signups, iArnold this month, plans, pending items, latest trainers).
 *
 * @param {object} adminDb - read-only admin Prisma client
 * @param {{ period?: string }} params
 * @returns {Promise<object>}
 */
export async function getOverviewQuery(adminDb, { period = OVERVIEW_DEFAULT_PERIOD } = {}) {
  const context = buildOverviewContext(new Date(), period);
  const results = await runOverviewQueries(adminDb, context);
  const trainerSummary = summarizeTrainerTiers(results.tierRows);
  const { windows } = context;
  return {
    period,
    generatedAt: context.now,
    range: { from: windows.from, to: windows.to },
    previousRange: { from: windows.previousFrom, to: windows.previousTo },
    kpis: {
      newTrainers: trainerSummary.newTrainers,
      newStudents: { current: results.studentRow.current, previous: results.studentRow.previous },
      activeTrainers: { current: results.sessionRow.trainers_current, previous: results.sessionRow.trainers_previous },
      completedSessions: { current: results.sessionRow.sessions_current, previous: results.sessionRow.sessions_previous },
    },
    weeklySignups: toWeeklySignups(context.weekStarts, results.weeklyRows),
    ai: summarizeAiUsage(context.billingMonth, results.aiRows),
    plans: trainerSummary.plans,
    pending: { ...results.pendingItems, trainersWithoutStudents: trainerSummary.trainersWithoutStudents },
    latestTrainers: results.latestRows.map(toLatestTrainer),
  };
}
