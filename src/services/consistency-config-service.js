import { AppError } from '../errors/app-error.js';
import {
  ConsistencyErrorCode,
  ConsistencyMessageCode,
  DEFAULT_CONFIG,
  pillarValues,
} from '../constants/consistency-ranking.js';
import { weekStartFor } from '../helpers/consistency-week.js';
import { formatDateOnly } from '../helpers/date-helpers.js';

const WEIGHT_TOTAL = 100;
const SEASON_WEEK_OPTIONS = Object.freeze([4, 8, 12]);
const MIN_PODIUM_RANGE = Object.freeze({ min: 1, max: 4 });
const MAX_CLOSE_WEEKDAY = 6;
const MAX_CLOSE_HOUR = 23;
const DAYS_IN_WEEK = 7;
const RULE_FIELDS = Object.freeze(['weights', 'activePillars', 'closeWeekday', 'closeHour', 'timeZone']);
const SETTING_FIELDS = Object.freeze(['seasonWeeks', 'minPodiumWeeks']);

// Civil date -> midnight-UTC Date matching @db.Date columns
function civilToDate({ year, month, day }) {
  return new Date(Date.UTC(year, month - 1, day));
}

// Midnight-UTC date of the Monday after the week containing the instant, in the timezone
function nextMondayDate(instant, timeZone) {
  const monday = weekStartFor(instant, timeZone);
  return new Date(Date.UTC(monday.year, monday.month - 1, monday.day + DAYS_IN_WEEK));
}

// Scoring-rule shape from a stored row or the defaults
function toRule(row) {
  const source = row ?? DEFAULT_CONFIG;
  return {
    weights: { ...source.weights },
    activePillars: [...source.activePillars],
    closeWeekday: source.closeWeekday,
    closeHour: source.closeHour,
    timeZone: source.timeZone,
  };
}

// Rule row in force at a Monday (latest effectiveFrom <= weekStart) or null
function findRuleRow(prisma, trainerId, weekStart) {
  return prisma.consistencyScoringRule.findFirst({
    where: { trainerId, effectiveFrom: { lte: civilToDate(weekStart) } },
    orderBy: { effectiveFrom: 'desc' },
  });
}

// Rule row in force at the instant; the week start depends on the timezone, so it re-reads once if the timezone differs
async function findCurrentRuleRow(prisma, trainerId, now) {
  const first = await findRuleRow(prisma, trainerId, weekStartFor(now, DEFAULT_CONFIG.timeZone));
  if (!first || first.timeZone === DEFAULT_CONFIG.timeZone) return first;
  return findRuleRow(prisma, trainerId, weekStartFor(now, first.timeZone));
}

// Newest rule row regardless of effectiveFrom (may be scheduled for a future Monday)
function findLatestRuleRow(prisma, trainerId) {
  return prisma.consistencyScoringRule.findFirst({
    where: { trainerId },
    orderBy: { effectiveFrom: 'desc' },
  });
}

// Stored season/podium settings merged over the defaults
function toSettings(configRow) {
  return {
    seasonWeeks: configRow?.seasonWeeks ?? DEFAULT_CONFIG.seasonWeeks,
    minPodiumWeeks: configRow?.minPodiumWeeks ?? DEFAULT_CONFIG.minPodiumWeeks,
  };
}

/**
 * Trainer's consistency configuration: defaults when nothing is stored, else the stored settings plus the rule in force now.
 *
 * @param {object} prisma
 * @param {string} trainerId
 * @param {Date} [now]
 * @returns {Promise<{ weights: object, activePillars: string[], closeWeekday: number, closeHour: number, timeZone: string, seasonWeeks: number, minPodiumWeeks: number }>}
 */
export async function getConfig(prisma, trainerId, now = new Date()) {
  const [configRow, ruleRow] = await Promise.all([
    prisma.consistencyRankingConfig.findUnique({ where: { trainerId } }),
    findCurrentRuleRow(prisma, trainerId, now),
  ]);
  return { ...toRule(ruleRow), ...toSettings(configRow) };
}

/**
 * Scoring rule in force for a week: latest rule with effectiveFrom <= weekStart, else the defaults.
 *
 * @param {object} prisma
 * @param {string} trainerId
 * @param {{ year: number, month: number, day: number }} weekStart - civil Monday
 * @returns {Promise<{ weights: object, activePillars: string[], closeWeekday: number, closeHour: number, timeZone: string }>}
 */
export async function ruleForWeek(prisma, trainerId, weekStart) {
  return toRule(await findRuleRow(prisma, trainerId, weekStart));
}

// Whether the value is an integer in [min, max]
function isIntegerInRange(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

// Whether the string is a recognised IANA timezone
function isValidTimeZone(value) {
  if (typeof value !== 'string' || value.length === 0 || /^[+-]/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// Reason for an invalid weights object, or null when valid
function weightsProblem(weights) {
  if (weights === null || typeof weights !== 'object' || Array.isArray(weights)) return 'invalid';
  const keys = Object.keys(weights);
  if (keys.length !== pillarValues.length || !pillarValues.every((pillar) => keys.includes(pillar))) return 'invalid';
  if (!pillarValues.every((pillar) => isIntegerInRange(weights[pillar], 0, WEIGHT_TOTAL))) return 'outOfRange';
  const total = pillarValues.reduce((sum, pillar) => sum + weights[pillar], 0);
  return total === WEIGHT_TOTAL ? null : 'sumNot100';
}

// Whether the value is a non-empty list of distinct known pillars
function isValidPillarList(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    new Set(value).size === value.length &&
    value.every((pillar) => pillarValues.includes(pillar))
  );
}

// Reason per provided field, or null when the field is valid
function fieldProblems(input) {
  return {
    weights: weightsProblem(input.weights),
    activePillars: isValidPillarList(input.activePillars) ? null : 'invalid',
    seasonWeeks: SEASON_WEEK_OPTIONS.includes(input.seasonWeeks) ? null : 'invalid',
    minPodiumWeeks: isIntegerInRange(input.minPodiumWeeks, MIN_PODIUM_RANGE.min, MIN_PODIUM_RANGE.max) ? null : 'invalid',
    closeWeekday: isIntegerInRange(input.closeWeekday, 0, MAX_CLOSE_WEEKDAY) ? null : 'invalid',
    closeHour: isIntegerInRange(input.closeHour, 0, MAX_CLOSE_HOUR) ? null : 'invalid',
    timeZone: isValidTimeZone(input.timeZone) ? null : 'invalid',
  };
}

// Throws the 400 with per-field details when any provided field is invalid
function assertValidInput(input) {
  const details = Object.fromEntries(
    Object.entries(fieldProblems(input)).filter(([field, reason]) => input[field] !== undefined && reason),
  );
  if (Object.keys(details).length === 0) return;
  throw new AppError({
    httpStatus: 400,
    error: ConsistencyErrorCode.CONFIG_INVALID,
    messageCode: ConsistencyMessageCode.CONFIG_INVALID,
    message: 'Invalid consistency ranking configuration',
    details,
  });
}

// Subset of the input limited to the given fields that are present
function pickProvided(input, fields) {
  return Object.fromEntries(fields.filter((field) => input[field] !== undefined).map((field) => [field, input[field]]));
}

// Upsert of the rule row scheduled for a Monday
function upsertRule(tx, trainerId, effectiveFrom, rule) {
  return tx.consistencyScoringRule.upsert({
    where: { trainerId_effectiveFrom: { trainerId, effectiveFrom } },
    create: { trainerId, effectiveFrom, ...rule },
    update: rule,
  });
}

// Upsert of the per-trainer season/podium settings
function upsertSettings(tx, trainerId, changes) {
  return tx.consistencyRankingConfig.upsert({
    where: { trainerId },
    create: { trainerId, ...changes },
    update: changes,
  });
}

/**
 * Validates and saves the config: rule fields as a new rule effective next Monday, season/podium fields on the config.
 *
 * @param {object} prisma
 * @param {string} trainerId
 * @param {object} input - any of weights, activePillars, closeWeekday, closeHour, timeZone, seasonWeeks, minPodiumWeeks
 * @param {Date} [now]
 * @returns {Promise<{ weights: object, activePillars: string[], closeWeekday: number, closeHour: number, timeZone: string, seasonWeeks: number, minPodiumWeeks: number, effectiveFrom: string|null }>} effectiveFrom is the "YYYY-MM-DD" Monday the rule fields take effect (null when none changed)
 */
export async function updateConfig(prisma, trainerId, input, now = new Date()) {
  assertValidInput(input);
  const [configRow, currentRow, latestRow] = await Promise.all([
    prisma.consistencyRankingConfig.findUnique({ where: { trainerId } }),
    findCurrentRuleRow(prisma, trainerId, now),
    findLatestRuleRow(prisma, trainerId),
  ]);
  const ruleChanges = pickProvided(input, RULE_FIELDS);
  const settingChanges = pickProvided(input, SETTING_FIELDS);
  const hasRuleChange = Object.keys(ruleChanges).length > 0;
  const hasSettingChange = Object.keys(settingChanges).length > 0;
  const rule = { ...toRule(latestRow), ...ruleChanges };
  const effectiveFrom = nextMondayDate(now, toRule(currentRow).timeZone);
  if (hasRuleChange || hasSettingChange) {
    await prisma.$transaction(async (tx) => {
      if (hasRuleChange) await upsertRule(tx, trainerId, effectiveFrom, rule);
      if (hasSettingChange) await upsertSettings(tx, trainerId, settingChanges);
    });
  }
  return {
    ...rule,
    ...toSettings(configRow),
    ...settingChanges,
    effectiveFrom: hasRuleChange ? formatDateOnly(effectiveFrom) : null,
  };
}
