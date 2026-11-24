import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfig, ruleForWeek, scoringRuleProblems, updateConfig } from '../../src/services/consistency-config-service.js';
import { ConsistencyErrorCode, ConsistencyMessageCode, DEFAULT_CONFIG } from '../../src/constants/consistency-ranking.js';

const TRAINER_ID = 'trainer-1';
// Wednesday 2026-11-11 12:00 in Sao Paulo (UTC-3); the next Monday is 2026-11-16
const NOW = new Date('2026-11-11T15:00:00Z');
const NEXT_MONDAY = new Date(Date.UTC(2026, 10, 16));
const VALID_WEIGHTS = { workouts: 40, diet: 0, cardio: 20, feedback: 20, hydration: 20 };

// Builds a prisma mock holding the given stored rows
function createPrisma({ ruleRows = [], configRow = null } = {}) {
  const prisma = {
    consistencyRankingConfig: {
      findUnique: vi.fn().mockResolvedValue(configRow),
      upsert: vi.fn().mockResolvedValue({}),
    },
    consistencyScoringRule: {
      findFirst: vi.fn(async ({ where }) => {
        const limit = where.effectiveFrom?.lte;
        const candidates = ruleRows.filter((row) => !limit || row.effectiveFrom <= limit);
        return candidates.sort((a, b) => b.effectiveFrom - a.effectiveFrom)[0] ?? null;
      }),
      upsert: vi.fn().mockResolvedValue({}),
    },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation((callback) => callback(prisma));
  return prisma;
}

// Asserts no persistence call happened
function expectNoWrites(prisma) {
  expect(prisma.consistencyRankingConfig.upsert).not.toHaveBeenCalled();
  expect(prisma.consistencyScoringRule.upsert).not.toHaveBeenCalled();
  expect(prisma.$transaction).not.toHaveBeenCalled();
}

// Runs updateConfig expecting the 400 and returns the thrown error
async function rejectedWith(prisma, input) {
  const error = await updateConfig(prisma, TRAINER_ID, input, NOW).catch((caught) => caught);
  expect(error.httpStatus).toBe(400);
  expect(error.error).toBe(ConsistencyErrorCode.CONFIG_INVALID);
  expect(error.messageCode).toBe(ConsistencyMessageCode.CONFIG_INVALID);
  return error;
}

describe('getConfig', () => {
  it('RANK-34 returns the defaults', async () => {
    const config = await getConfig(createPrisma(), TRAINER_ID, NOW);
    expect(config).toEqual({
      weights: { workouts: 30, diet: 30, cardio: 15, feedback: 15, hydration: 10 },
      activePillars: ['workouts', 'cardio', 'feedback', 'hydration'],
      seasonWeeks: 4,
      minPodiumWeeks: 2,
      closeWeekday: 0,
      closeHour: 21,
      timeZone: 'America/Sao_Paulo',
      riskLimit: 70,
      riskWeeks: 2,
      minWorkoutMinutes: 10,
      batchCount: 5,
      batchMinutes: 30,
    });
  });

  it('returns the stored settings and the rule in force now, not a scheduled one', async () => {
    const prisma = createPrisma({
      configRow: { seasonWeeks: 8, minPodiumWeeks: 3 },
      ruleRows: [
        { effectiveFrom: new Date(Date.UTC(2026, 10, 9)), weights: VALID_WEIGHTS, activePillars: ['workouts'], closeWeekday: 6, closeHour: 18, timeZone: 'America/Manaus' },
        { effectiveFrom: NEXT_MONDAY, weights: DEFAULT_CONFIG.weights, activePillars: ['diet'], closeWeekday: 0, closeHour: 21, timeZone: 'America/Sao_Paulo' },
      ],
    });
    const config = await getConfig(prisma, TRAINER_ID, NOW);
    expect(config).toMatchObject({ seasonWeeks: 8, minPodiumWeeks: 3, activePillars: ['workouts'], closeWeekday: 6, closeHour: 18, timeZone: 'America/Manaus' });
  });
});

describe('ruleForWeek', () => {
  it('picks the latest rule with effectiveFrom on or before the week', async () => {
    const prisma = createPrisma({
      ruleRows: [
        { effectiveFrom: new Date(Date.UTC(2026, 9, 5)), weights: DEFAULT_CONFIG.weights, activePillars: ['diet'], closeWeekday: 0, closeHour: 21, timeZone: 'America/Sao_Paulo' },
        { effectiveFrom: new Date(Date.UTC(2026, 10, 9)), weights: VALID_WEIGHTS, activePillars: ['workouts'], closeWeekday: 5, closeHour: 20, timeZone: 'America/Manaus' },
      ],
    });
    const rule = await ruleForWeek(prisma, TRAINER_ID, { year: 2026, month: 11, day: 9 });
    expect(rule).toEqual({ weights: VALID_WEIGHTS, activePillars: ['workouts'], closeWeekday: 5, closeHour: 20, timeZone: 'America/Manaus' });
    const older = await ruleForWeek(prisma, TRAINER_ID, { year: 2026, month: 10, day: 12 });
    expect(older.activePillars).toEqual(['diet']);
  });

  it('falls back to the defaults before any rule exists', async () => {
    const rule = await ruleForWeek(createPrisma(), TRAINER_ID, { year: 2026, month: 11, day: 9 });
    expect(rule).toEqual({
      weights: DEFAULT_CONFIG.weights,
      activePillars: DEFAULT_CONFIG.activePillars,
      closeWeekday: 0,
      closeHour: 21,
      timeZone: 'America/Sao_Paulo',
    });
  });
});

describe('updateConfig', () => {
  let prisma;

  beforeEach(() => {
    prisma = createPrisma();
  });

  it('RANK-35 rejects weights that do not sum to 100', async () => {
    const sumWrong = await rejectedWith(prisma, { weights: { ...VALID_WEIGHTS, workouts: 41 } });
    expect(sumWrong.details.weights).toBeDefined();
    const outOfRange = await rejectedWith(prisma, { weights: { workouts: 120, diet: -20, cardio: 0, feedback: 0, hydration: 0 } });
    expect(outOfRange.details.weights).toBeDefined();
    const fractional = await rejectedWith(prisma, { weights: { workouts: 40.5, diet: 0, cardio: 19.5, feedback: 20, hydration: 20 } });
    expect(fractional.details.weights).toBeDefined();
    expectNoWrites(prisma);
  });

  it('RANK-36 rejects invalid duration, podium minimum, close time or timezone', async () => {
    const error = await rejectedWith(prisma, { seasonWeeks: 6, minPodiumWeeks: 5, closeWeekday: 7, closeHour: 24, timeZone: 'Mars/Olympus' });
    expect(Object.keys(error.details).sort()).toEqual(['closeHour', 'closeWeekday', 'minPodiumWeeks', 'seasonWeeks', 'timeZone']);
    await rejectedWith(prisma, { minPodiumWeeks: 0 });
    await rejectedWith(prisma, { closeHour: -1 });
    await rejectedWith(prisma, { closeWeekday: -1 });
    await rejectedWith(prisma, { seasonWeeks: 16 });
    expectNoWrites(prisma);
  });

  it('RANK-37 schedules weights for next Monday', async () => {
    const result = await updateConfig(prisma, TRAINER_ID, { weights: VALID_WEIGHTS, activePillars: ['workouts', 'diet'] }, NOW);
    expect(prisma.consistencyScoringRule.upsert).toHaveBeenCalledTimes(1);
    const call = prisma.consistencyScoringRule.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ trainerId_effectiveFrom: { trainerId: TRAINER_ID, effectiveFrom: NEXT_MONDAY } });
    expect(call.create).toMatchObject({
      trainerId: TRAINER_ID,
      effectiveFrom: NEXT_MONDAY,
      weights: VALID_WEIGHTS,
      activePillars: ['workouts', 'diet'],
      closeWeekday: 0,
      closeHour: 21,
      timeZone: 'America/Sao_Paulo',
    });
    expect(result.effectiveFrom).toBe('2026-11-16');
    expect(prisma.consistencyRankingConfig.upsert).not.toHaveBeenCalled();
  });

  it('RANK-38 applies season length to the next season', async () => {
    const result = await updateConfig(prisma, TRAINER_ID, { seasonWeeks: 8 }, NOW);
    expect(prisma.consistencyRankingConfig.upsert).toHaveBeenCalledWith({
      where: { trainerId: TRAINER_ID },
      create: { trainerId: TRAINER_ID, seasonWeeks: 8 },
      update: { seasonWeeks: 8 },
    });
    expect(prisma.consistencyScoringRule.upsert).not.toHaveBeenCalled();
    expect(result.seasonWeeks).toBe(8);
    expect(result.effectiveFrom).toBeNull();
  });

  it('RANK-39 applies the podium minimum immediately', async () => {
    await updateConfig(prisma, TRAINER_ID, { minPodiumWeeks: 3 }, NOW);
    expect(prisma.consistencyRankingConfig.upsert).toHaveBeenCalledWith({
      where: { trainerId: TRAINER_ID },
      create: { trainerId: TRAINER_ID, minPodiumWeeks: 3 },
      update: { minPodiumWeeks: 3 },
    });
    expect(prisma.consistencyScoringRule.upsert).not.toHaveBeenCalled();
    prisma.consistencyRankingConfig.findUnique.mockResolvedValue({ seasonWeeks: 4, minPodiumWeeks: 3 });
    expect((await getConfig(prisma, TRAINER_ID, NOW)).minPodiumWeeks).toBe(3);
  });

  it('RANK-40 schedules timezone and close time for next week', async () => {
    const existing = { effectiveFrom: new Date(Date.UTC(2026, 10, 9)), weights: VALID_WEIGHTS, activePillars: ['workouts'], closeWeekday: 0, closeHour: 21, timeZone: 'America/Sao_Paulo' };
    prisma = createPrisma({ ruleRows: [existing] });
    await updateConfig(prisma, TRAINER_ID, { closeWeekday: 6, closeHour: 18, timeZone: 'America/Manaus' }, NOW);
    expect(prisma.consistencyScoringRule.upsert).toHaveBeenCalledTimes(1);
    const call = prisma.consistencyScoringRule.upsert.mock.calls[0][0];
    expect(call.create).toMatchObject({ effectiveFrom: NEXT_MONDAY, closeWeekday: 6, closeHour: 18, timeZone: 'America/Manaus', weights: VALID_WEIGHTS, activePillars: ['workouts'] });
  });

  it('computes next Monday in the current timezone of the trainer', async () => {
    const lateSundayInSaoPaulo = new Date('2026-11-16T01:00:00Z');
    await updateConfig(prisma, TRAINER_ID, { closeHour: 20 }, lateSundayInSaoPaulo);
    expect(prisma.consistencyScoringRule.upsert.mock.calls[0][0].create.effectiveFrom).toEqual(NEXT_MONDAY);
  });

  it('writes the rule and the settings in a single transaction', async () => {
    await updateConfig(prisma, TRAINER_ID, { closeHour: 20, seasonWeeks: 12 }, NOW);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.consistencyScoringRule.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.consistencyRankingConfig.upsert).toHaveBeenCalledTimes(1);
  });
});

const PANEL_RULE_BOUNDS = [
  ['riskLimit', 50, 90],
  ['riskWeeks', 1, 4],
  ['minWorkoutMinutes', 0, 60],
  ['batchCount', 2, 20],
  ['batchMinutes', 10, 120],
];

describe('panel rules', () => {
  let prisma;

  beforeEach(() => {
    prisma = createPrisma();
  });

  it('PAN-41 returns the stored risk, quick completion and batch logging rules', async () => {
    prisma.consistencyRankingConfig.findUnique.mockResolvedValue({
      seasonWeeks: 4,
      minPodiumWeeks: 2,
      riskLimit: 60,
      riskWeeks: 3,
      minWorkoutMinutes: 15,
      batchCount: 8,
      batchMinutes: 45,
    });

    expect(await getConfig(prisma, TRAINER_ID, NOW)).toMatchObject({
      riskLimit: 60,
      riskWeeks: 3,
      minWorkoutMinutes: 15,
      batchCount: 8,
      batchMinutes: 45,
    });
  });

  it('PAN-41 saves the panel rules with immediate effect and no scheduled rule', async () => {
    const input = { riskLimit: 60, riskWeeks: 3, minWorkoutMinutes: 15, batchCount: 8, batchMinutes: 45 };

    const result = await updateConfig(prisma, TRAINER_ID, input, NOW);

    expect(prisma.consistencyRankingConfig.upsert).toHaveBeenCalledWith({
      where: { trainerId: TRAINER_ID },
      create: { trainerId: TRAINER_ID, ...input },
      update: input,
    });
    expect(prisma.consistencyScoringRule.upsert).not.toHaveBeenCalled();
    expect(result).toMatchObject(input);
    expect(result.effectiveFrom).toBeNull();
  });

  it('PAN-41 keeps the defaults of the rules that were not sent', async () => {
    const result = await updateConfig(prisma, TRAINER_ID, { riskLimit: 65 }, NOW);

    expect(result).toMatchObject({ riskLimit: 65, riskWeeks: 2, minWorkoutMinutes: 10, batchCount: 5, batchMinutes: 30 });
  });

  it.each(PANEL_RULE_BOUNDS)('PAN-41 accepts the limits of %s (%i to %i)', async (field, min, max) => {
    await updateConfig(prisma, TRAINER_ID, { [field]: min }, NOW);
    await updateConfig(prisma, TRAINER_ID, { [field]: max }, NOW);

    expect(prisma.consistencyRankingConfig.upsert).toHaveBeenCalledTimes(2);
  });

  it.each(PANEL_RULE_BOUNDS)('PAN-41 rejects %s outside %i to %i and non-integers', async (field, min, max) => {
    for (const value of [min - 1, max + 1, min + 0.5, '60', null]) {
      const error = await rejectedWith(prisma, { [field]: value });
      expect(Object.keys(error.details)).toEqual([field]);
    }
    expectNoWrites(prisma);
  });
});

describe('scoringRuleProblems', () => {
  const ACTIVE = ['workouts', 'cardio'];

  it('CPD-08 flags weights that miss a pillar, leave 0 to 100 or do not sum 100 and an empty, repeated or unknown pillar list', () => {
    expect(scoringRuleProblems({ weights: VALID_WEIGHTS, activePillars: ACTIVE })).toEqual({ weights: null, activePillars: null });

    const { hydration: _dropped, ...missingPillar } = VALID_WEIGHTS;
    expect(scoringRuleProblems({ weights: missingPillar, activePillars: ACTIVE }).weights).toBe('invalid');
    expect(scoringRuleProblems({ weights: { ...VALID_WEIGHTS, steps: 0 }, activePillars: ACTIVE }).weights).toBe('invalid');
    expect(scoringRuleProblems({ weights: undefined, activePillars: ACTIVE }).weights).toBe('invalid');
    expect(scoringRuleProblems({ weights: { ...VALID_WEIGHTS, workouts: 120, diet: -80 }, activePillars: ACTIVE }).weights).toBe('outOfRange');
    expect(scoringRuleProblems({ weights: { ...VALID_WEIGHTS, workouts: 39.5, diet: 0.5 }, activePillars: ACTIVE }).weights).toBe('outOfRange');
    expect(scoringRuleProblems({ weights: { ...VALID_WEIGHTS, workouts: 50 }, activePillars: ACTIVE }).weights).toBe('sumNot100');

    expect(scoringRuleProblems({ weights: VALID_WEIGHTS, activePillars: [] }).activePillars).toBe('invalid');
    expect(scoringRuleProblems({ weights: VALID_WEIGHTS, activePillars: ['workouts', 'workouts'] }).activePillars).toBe('invalid');
    expect(scoringRuleProblems({ weights: VALID_WEIGHTS, activePillars: ['workouts', 'steps'] }).activePillars).toBe('invalid');
    expect(scoringRuleProblems({ weights: VALID_WEIGHTS, activePillars: undefined }).activePillars).toBe('invalid');
    expect(scoringRuleProblems({ weights: VALID_WEIGHTS, activePillars: ['diet'] })).toEqual({ weights: null, activePillars: null });
  });
});
