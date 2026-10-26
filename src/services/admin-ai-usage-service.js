import { PLATFORM_PLAN_TIERS, getBillingMonth } from '../constants/platform-plan.js';

const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];

// Builds a zeroed token counter set (including totalTokens and turns).
function emptyCounters() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, turns: 0 };
}

// Converts a groupBy row into numeric counters, treating null sums as zero.
function toCounters(group) {
  const counters = emptyCounters();
  TOKEN_FIELDS.forEach((field) => {
    counters[field] = group._sum[field] ?? 0;
    counters.totalTokens += counters[field];
  });
  counters.turns = group._count._all;
  return counters;
}

// Adds one counter set into the running month totals.
function addCounters(totals, counters) {
  Object.keys(totals).forEach((key) => {
    totals[key] += counters[key];
  });
}

// Aggregates iArnold token usage for a billing month, overall and per trainer.
export async function getAiUsageByMonth(prisma, { month } = {}) {
  const billingMonth = month ?? getBillingMonth();

  const groups = await prisma.aiTokenUsage.groupBy({
    by: ['trainerId'],
    where: { billingMonth },
    _sum: Object.fromEntries(TOKEN_FIELDS.map((field) => [field, true])),
    _count: { _all: true },
  });

  const trainerRows = groups.length === 0 ? [] : await prisma.trainer.findMany({
    where: { id: { in: groups.map((group) => group.trainerId) } },
    select: {
      id: true,
      user: { select: { firstName: true, lastName: true, email: true } },
      platformSubscription: { select: { tier: true } },
    },
  });
  const trainersById = new Map(trainerRows.map((trainer) => [trainer.id, trainer]));

  const totals = emptyCounters();
  const trainers = groups.map((group) => {
    const counters = toCounters(group);
    addCounters(totals, counters);
    const trainer = trainersById.get(group.trainerId);
    return {
      trainerId: group.trainerId,
      firstName: trainer?.user?.firstName ?? null,
      lastName: trainer?.user?.lastName ?? null,
      email: trainer?.user?.email ?? null,
      tier: trainer?.platformSubscription?.tier ?? PLATFORM_PLAN_TIERS.FREE,
      ...counters,
    };
  });
  trainers.sort((a, b) => b.totalTokens - a.totalTokens);

  return { month: billingMonth, totals, trainers };
}
