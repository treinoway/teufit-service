/**
 * In-memory Prisma for the student consistency views: the tables the real standings, config, pause and privacy code reads,
 * answering findMany/findFirst/findUnique/count with where, select, include and orderBy like Prisma does.
 */

import { Prisma } from '@prisma/client';
import { DEFAULT_CONFIG, WeekStatus } from '../../src/constants/consistency-ranking.js';
import { scoreWeek } from '../../src/helpers/consistency-math.js';

const { Decimal } = Prisma;
const RELATIONS = {
  challengeParticipant: { student: (world, row) => world.tables.user.find((user) => user.id === row.studentId) ?? null },
  challengeConsistencyStanding: { student: (world, row) => world.tables.user.find((user) => user.id === row.studentId) ?? null },
};
const RELATION_FILTERS = {
  challenge: {
    participants: (world, row, filter) => world.tables.challengeParticipant.some(
      (participant) => participant.challengeId === row.id && matches(world, 'challengeParticipant', participant, filter.some),
    ),
  },
};

// Comparable primitive of a stored or queried value (Dates by time, Decimals by number)
function comparable(value) {
  if (value instanceof Date) return value.getTime();
  if (value instanceof Decimal) return value.toNumber();
  return value;
}

// Whether the value is a Prisma operator object ({ in, lte, ... }) rather than a plain value
function isOperatorObject(condition) {
  return condition !== null && typeof condition === 'object' && !(condition instanceof Date) && !(condition instanceof Decimal) && !Array.isArray(condition);
}

// Whether a stored value satisfies one where condition
function matchesValue(value, condition) {
  if (!isOperatorObject(condition)) return comparable(value) === comparable(condition) || (value == null && condition == null);
  return Object.entries(condition).every(([operator, operand]) => {
    const left = comparable(value);
    if (operator === 'in') return operand.some((item) => comparable(item) === left);
    if (operator === 'not') return operand === null ? value != null : left !== comparable(operand);
    if (operator === 'lte') return left <= comparable(operand);
    if (operator === 'lt') return left < comparable(operand);
    if (operator === 'gte') return left >= comparable(operand);
    if (operator === 'gt') return left > comparable(operand);
    throw new Error(`Unsupported operator ${operator}`);
  });
}

// Whether a row satisfies a where clause (compound unique keys are flattened)
function matches(world, table, row, where = {}) {
  return Object.entries(where).every(([field, condition]) => {
    const relationFilter = RELATION_FILTERS[table]?.[field];
    if (relationFilter) return relationFilter(world, row, condition);
    if (field.includes('_') && isOperatorObject(condition) && !(field in row)) return matches(world, table, row, condition);
    return matchesValue(row[field], condition);
  });
}

// Row projected through select/include, resolving the relations the code asks for
function project(world, table, row, { select, include } = {}) {
  const shape = select ?? include;
  const base = select ? {} : { ...row };
  if (!shape) return base;
  for (const [field, spec] of Object.entries(shape)) {
    const relation = RELATIONS[table]?.[field];
    if (relation) {
      const related = relation(world, row);
      base[field] = related && isOperatorObject(spec) && spec.select ? Object.fromEntries(Object.keys(spec.select).map((key) => [key, related[key]])) : related;
    } else if (spec) {
      base[field] = row[field];
    }
  }
  return base;
}

// Rows ordered by Prisma orderBy (object or list of objects)
function ordered(rows, orderBy) {
  const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).flatMap((entry) => Object.entries(entry));
  return [...rows].sort((a, b) => {
    for (const [field, direction] of keys) {
      const left = comparable(a[field]);
      const right = comparable(b[field]);
      if (left === right) continue;
      return (left < right ? -1 : 1) * (direction === 'desc' ? -1 : 1);
    }
    return 0;
  });
}

// Prisma-like delegate of one table
function delegate(world, table) {
  const rows = () => world.tables[table];
  const found = (args = {}) => ordered(rows().filter((row) => matches(world, table, row, args.where)), args.orderBy);
  return {
    findMany: async (args = {}) => found(args).map((row) => project(world, table, row, args)),
    findFirst: async (args = {}) => {
      const [row] = found(args);
      return row ? project(world, table, row, args) : null;
    },
    findUnique: async (args = {}) => {
      const [row] = found(args);
      return row ? project(world, table, row, args) : null;
    },
    count: async (args = {}) => found(args).length,
  };
}

/**
 * Empty world with the tables of the student consistency views.
 *
 * @returns {{ tables: object, targets: Map, done: Map, prisma: object }}
 */
export function createWorld() {
  const world = {
    tables: {
      user: [],
      trainerStudent: [],
      challenge: [],
      challengeParticipant: [],
      challengeConsistencyStanding: [],
      consistencyWeeklyResult: [],
      consistencyPrivacyPref: [],
      consistencyRankingConfig: [],
      consistencyScoringRule: [],
      consistencyWeekPause: [],
    },
    targets: new Map(),
    done: new Map(),
  };
  world.prisma = Object.fromEntries(Object.keys(world.tables).map((table) => [table, delegate(world, table)]));
  return world;
}

// Date-only column value (midnight UTC), as Prisma returns @db.Date
export const dateOnly = (iso) => new Date(`${iso}T00:00:00.000Z`);

/**
 * Stored weekly result of a closed week as the weekly close writes it: per-pillar counts and, for a valid week, the general-rule score.
 *
 * @param {string} trainerId
 * @param {string} studentId
 * @param {string} week - "YYYY-MM-DD" Monday
 * @param {{ workouts?: [number, number], cardio?: [number, number] }} counts - [done, expected]
 * @param {{ status?: string }} [stored] - paused or neutral weeks keep a null score
 * @returns {object}
 */
export function weeklyResult(trainerId, studentId, week, counts, { status = WeekStatus.VALID } = {}) {
  const pillars = Object.fromEntries(Object.entries(counts).map(([pillar, [done, expected]]) => [pillar, { done, expected }]));
  const expected = Object.fromEntries(Object.entries(pillars).map(([pillar, row]) => [pillar, row.expected]));
  const done = Object.fromEntries(Object.entries(pillars).map(([pillar, row]) => [pillar, row.done]));
  const score = status === WeekStatus.VALID ? scoreWeek({ expected, done, ...DEFAULT_CONFIG }) : null;
  return {
    id: `wr-${studentId}-${week}`,
    trainerId,
    studentId,
    seasonId: null,
    weekStart: dateOnly(week),
    status,
    score,
    pillars,
    weights: { ...DEFAULT_CONFIG.weights },
    closedAt: new Date(`${week}T00:00:00.000Z`),
  };
}

/**
 * Mock implementation of materializeTargets/countDone reading a per-student map of { workouts, cardio }.
 *
 * @param {Map<string, { workouts: number, cardio: number }>} source
 * @returns {Function}
 */
export function countsFrom(source) {
  return async (_prisma, _trainerId, _weekOrIds, idsOrWindow) => {
    const ids = Array.isArray(_weekOrIds) ? _weekOrIds : idsOrWindow;
    return new Map(ids.map((id) => [id, { workouts: 0, cardio: 0, ...source.get(id) }]));
  };
}
