import { vi } from 'vitest';
import { SubscriptionStatus } from '../../src/constants/subscription.js';

const SET_OPERATORS = Object.freeze(['in', 'not']);

// True when a Prisma-style condition matches a single field value (equality, { in }, { not }).
function matchesCondition(value, condition) {
  if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
    const operators = Object.keys(condition);
    const unknown = operators.filter((operator) => !SET_OPERATORS.includes(operator));
    if (unknown.length > 0) throw new Error(`unlink-world: unsupported where operator ${unknown.join(',')}`);
    if (operators.includes('in') && !condition.in.includes(value)) return false;
    if (operators.includes('not') && value === condition.not) return false;
    return true;
  }
  return value === condition;
}

// True when a row satisfies a Prisma-style where (field conditions, OR, AND).
export function matchesWhere(row, where = {}) {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') return condition.some((branch) => matchesWhere(row, branch));
    if (key === 'AND') return condition.every((branch) => matchesWhere(row, branch));
    return matchesCondition(row[key], condition);
  });
}

/** In-memory transaction client for an unlink: where clauses are really evaluated, so tests assert outcomes instead of query shape. */
export function createUnlinkWorld({
  userId,
  trainerId,
  nutritionistId,
  subscriptions,
  trainerLinked = false,
  patientLinked = false,
}) {
  const state = { trainerLinked, patientLinked, subscriptions: subscriptions.map((row) => ({ ...row })) };
  const voidedSubscriptionIds = new Set();

  const trainerRow = trainerId ? { id: trainerId, userId, deletedAt: null } : null;
  const nutritionistRow = nutritionistId ? { id: nutritionistId, userId, deletedAt: null } : null;
  const trainerLink = () => (state.trainerLinked ? { id: 'trainer-link' } : null);
  const patientLink = () => (state.patientLinked ? { id: 'patient-link', deletedAt: null } : null);
  const softDeletePatientLink = vi.fn(async () => {
    state.patientLinked = false;
    return {};
  });

  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    trainer: {
      findFirst: vi.fn(async () => trainerRow),
      findUnique: vi.fn(async () => trainerRow),
    },
    nutritionist: {
      findFirst: vi.fn(async () => nutritionistRow),
      findUnique: vi.fn(async () => nutritionistRow),
    },
    trainerStudent: {
      delete: vi.fn(async () => {
        state.trainerLinked = false;
        return {};
      }),
      findFirst: vi.fn(async () => trainerLink()),
      findUnique: vi.fn(async () => trainerLink()),
      count: vi.fn(async () => (state.trainerLinked ? 1 : 0)),
    },
    nutritionistPatient: {
      update: softDeletePatientLink,
      updateMany: softDeletePatientLink,
      findFirst: vi.fn(async () => patientLink()),
      findUnique: vi.fn(async () => patientLink()),
      count: vi.fn(async () => (state.patientLinked ? 1 : 0)),
    },
    studentSubscription: {
      findMany: vi.fn(async ({ where }) => state.subscriptions.filter((row) => matchesWhere(row, where))),
      updateMany: vi.fn(async ({ where, data }) => {
        const matched = state.subscriptions.filter((row) => matchesWhere(row, where));
        matched.forEach((row) => Object.assign(row, data));
        return { count: matched.length };
      }),
    },
    subscriptionPayment: {
      updateMany: vi.fn(async ({ where }) => {
        const matched = state.subscriptions.filter((row) => matchesWhere(row, where.subscription));
        matched.forEach((row) => voidedSubscriptionIds.add(row.id));
        return { count: matched.length };
      }),
    },
  };

  return {
    tx,
    runTransaction: async (callback) => callback(tx),
    cancelledIds: () =>
      state.subscriptions.filter((row) => row.status === SubscriptionStatus.CANCELLED).map((row) => row.id).sort(),
    voidedIds: () => [...voidedSubscriptionIds].sort(),
    subscription: (id) => state.subscriptions.find((row) => row.id === id),
  };
}
