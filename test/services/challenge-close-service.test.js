import { beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDueChallenges, requestEarlyClose } from '../../src/services/challenge-close-service.js';
import { computeChallengeStandings } from '../../src/services/challenge-consistency-service.js';
import { getConfig, ruleForWeek } from '../../src/services/consistency-config-service.js';
import { ChallengeErrorCode, ChallengeMessageCode, ChallengeStatus } from '../../src/constants/challenge.js';

vi.mock('../../src/services/consistency-config-service.js', () => ({ getConfig: vi.fn(), ruleForWeek: vi.fn() }));
vi.mock('../../src/services/challenge-consistency-service.js', async (importOriginal) => ({
  ...(await importOriginal()),
  computeChallengeStandings: vi.fn(),
}));

const SP = 'America/Sao_Paulo';
const TRAINER_ID = 'trainer-1';
const TRAINER_USER_ID = 'trainer-user-1';
const RULE = {
  weights: { workouts: 30, diet: 30, cardio: 15, feedback: 15, hydration: 10 },
  activePillars: ['workouts', 'cardio', 'feedback', 'hydration'],
  closeWeekday: 0,
  closeHour: 21,
  timeZone: SP,
};
const CONFIG = { ...RULE, seasonWeeks: 4, minPodiumWeeks: 2 };
// Sunday 2026-11-15 21:15 in São Paulo, 15 minutes after the close of the week of Monday 2026-11-09
const AFTER_CLOSE = new Date('2026-11-16T00:15:00.000Z');
// Sunday 2026-11-15 20:45 in São Paulo, before that close
const BEFORE_CLOSE = new Date('2026-11-15T23:45:00.000Z');

const prisma = {
  trainer: { findUnique: vi.fn() },
  challenge: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  consistencyWeekClose: { findUnique: vi.fn() },
  consistencySeason: { findFirst: vi.fn() },
  challengeConsistencyStanding: { createMany: vi.fn() },
  $queryRaw: vi.fn(),
  $transaction: vi.fn(async (fn) => fn(prisma)),
};
const logger = { info: vi.fn(), error: vi.fn() };

// Date-only column value (midnight UTC), as Prisma returns @db.Date
const dateOnly = (iso) => new Date(`${iso}T00:00:00.000Z`);

// Weekly championship of 2 weeks whose last week is the one of Monday 2026-11-09, unless overridden
function championship(overrides = {}) {
  return {
    id: 'champ-a',
    trainerId: TRAINER_ID,
    name: 'Sprint',
    format: 'weeks',
    startDate: dateOnly('2026-11-02'),
    endDate: dateOnly('2026-11-15'),
    weeks: 2,
    minPodiumWeeks: 2,
    cancelledAt: null,
    closedAt: null,
    closeRequestedAt: null,
    ...overrides,
  };
}

// Live standings with two ranked students and one entering
function standings() {
  return {
    rows: [
      { studentId: 'ana', position: 1, eligible: true, average: 95, validWeeks: 2, weeksAt100: 1, streak: 1 },
      { studentId: 'bia', position: 2, eligible: true, average: 80.5, validWeeks: 2, weeksAt100: 0, streak: 0 },
    ],
    entering: [{ studentId: 'caio', position: null, eligible: false, average: 70, validWeeks: 1, weeksAt100: 0, streak: 0 }],
    currentWeek: 2,
    closesAt: new Date('2026-11-16T00:00:00.000Z'),
  };
}

// Wires the candidate championships (each re-read inside its transaction) and the week-close mark
function arrange(challenges, { marked = true, activeSeason = null } = {}) {
  prisma.challenge.findMany.mockResolvedValue(challenges);
  prisma.challenge.findUnique.mockImplementation(async ({ where }) => challenges.find((row) => row.id === where.id) ?? null);
  prisma.consistencyWeekClose.findUnique.mockResolvedValue(marked ? { id: 'mark' } : null);
  prisma.consistencySeason.findFirst.mockResolvedValue(activeSeason);
}

beforeEach(() => {
  getConfig.mockResolvedValue(CONFIG);
  ruleForWeek.mockResolvedValue(RULE);
  prisma.$queryRaw.mockResolvedValue([{ locked: true }]);
  prisma.challengeConsistencyStanding.createMany.mockResolvedValue({ count: 3 });
  prisma.challenge.update.mockImplementation(async ({ data }) => ({ ...championship(), ...data }));
  prisma.trainer.findUnique.mockResolvedValue({ id: TRAINER_ID });
  computeChallengeStandings.mockResolvedValue(standings());
});

describe('closeDueChallenges', () => {
  it('CAMP-32 freezes the standings and closes a championship whose last week has the closed-week mark', async () => {
    arrange([championship()]);

    await closeDueChallenges(prisma, logger, AFTER_CLOSE);

    expect(prisma.consistencyWeekClose.findUnique).toHaveBeenCalledWith({
      where: { trainerId_weekStart: { trainerId: TRAINER_ID, weekStart: dateOnly('2026-11-09') } },
    });
    expect(prisma.challengeConsistencyStanding.createMany).toHaveBeenCalledWith({
      data: [
        { challengeId: 'champ-a', studentId: 'ana', position: 1, eligible: true, average: 95, validWeeks: 2, weeks100: 1, streak: 1, frozenAt: AFTER_CLOSE },
        { challengeId: 'champ-a', studentId: 'bia', position: 2, eligible: true, average: 80.5, validWeeks: 2, weeks100: 0, streak: 0, frozenAt: AFTER_CLOSE },
        { challengeId: 'champ-a', studentId: 'caio', position: null, eligible: false, average: 70, validWeeks: 1, weeks100: 0, streak: 0, frozenAt: AFTER_CLOSE },
      ],
      skipDuplicates: true,
    });
    expect(prisma.challenge.update).toHaveBeenCalledWith({ where: { id: 'champ-a' }, data: { closedAt: AFTER_CLOSE } });
  });

  it('CAMP-32 closes after the close instant when the trainer has no active season (no mark is ever written)', async () => {
    arrange([championship()], { marked: false, activeSeason: null });

    await closeDueChallenges(prisma, logger, AFTER_CLOSE);

    expect(prisma.challenge.update).toHaveBeenCalledWith({ where: { id: 'champ-a' }, data: { closedAt: AFTER_CLOSE } });
  });

  it('CAMP-32 waits for the weekly close while the trainer has an active season and no mark yet', async () => {
    arrange([championship()], { marked: false, activeSeason: { id: 's1' } });

    await closeDueChallenges(prisma, logger, AFTER_CLOSE);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.challenge.update).not.toHaveBeenCalled();
  });

  it('CAMP-32 does not close before the close instant of the last week', async () => {
    arrange([championship()], { marked: false, activeSeason: null });

    await closeDueChallenges(prisma, logger, BEFORE_CLOSE);

    expect(prisma.challenge.update).not.toHaveBeenCalled();
  });

  it('CAMP-32 only looks at open weekly championships', async () => {
    arrange([]);

    await closeDueChallenges(prisma, logger, AFTER_CLOSE);

    expect(prisma.challenge.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ format: 'weeks', closedAt: null, cancelledAt: null }),
    }));
  });

  it('CAMP-34 skips a championship whose lock another run holds', async () => {
    arrange([championship()]);
    prisma.$queryRaw.mockResolvedValue([{ locked: false }]);

    await closeDueChallenges(prisma, logger, AFTER_CLOSE);

    expect(prisma.challengeConsistencyStanding.createMany).not.toHaveBeenCalled();
    expect(prisma.challenge.update).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('CAMP-33 skips a championship another run already closed', async () => {
    const candidate = championship();
    arrange([candidate]);
    prisma.challenge.findUnique.mockResolvedValue({ ...candidate, closedAt: new Date('2026-11-16T00:01:00.000Z') });

    await closeDueChallenges(prisma, logger, AFTER_CLOSE);

    expect(computeChallengeStandings).not.toHaveBeenCalled();
    expect(prisma.challengeConsistencyStanding.createMany).not.toHaveBeenCalled();
    expect(prisma.challenge.update).not.toHaveBeenCalled();
  });

  it('CAMP-35 logs a failing championship and closes the others', async () => {
    arrange([championship({ id: 'champ-a' }), championship({ id: 'champ-b' })]);
    const failure = new Error('boom');
    computeChallengeStandings.mockRejectedValueOnce(failure);

    await closeDueChallenges(prisma, logger, AFTER_CLOSE);

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ challengeId: 'champ-a', err: failure }),
      expect.stringContaining('champ-a'),
    );
    expect(prisma.challenge.update).toHaveBeenCalledTimes(1);
    expect(prisma.challenge.update).toHaveBeenCalledWith({ where: { id: 'champ-b' }, data: { closedAt: AFTER_CLOSE } });
  });

  it('CAMP-38 logs the id and the number ranked', async () => {
    arrange([championship()]);

    await closeDueChallenges(prisma, logger, AFTER_CLOSE);

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ challengeId: 'champ-a', trainerId: TRAINER_ID, ranked: 2 }),
      expect.stringMatching(/champ-a.*2 ranked/),
    );
  });
});

// Weekly championship of 8 weeks from Monday 2026-11-02 (Wednesday 2026-11-18 is in its 3rd week)
function eightWeeks(overrides = {}) {
  return championship({
    startDate: dateOnly('2026-11-02'), endDate: dateOnly('2026-12-27'), weeks: 8, minPodiumWeeks: 2, ...overrides,
  });
}

// Wednesday 2026-11-18 12:00 in São Paulo
const WEDNESDAY_WEEK3 = new Date('2026-11-18T15:00:00.000Z');

describe('requestEarlyClose', () => {
  it('CAMP-42 schedules the close for this week and moves the end to its Sunday', async () => {
    prisma.challenge.findUnique.mockResolvedValue(eightWeeks());

    const result = await requestEarlyClose(prisma, TRAINER_USER_ID, 'champ-a', WEDNESDAY_WEEK3);

    expect(prisma.challenge.update).toHaveBeenCalledWith({
      where: { id: 'champ-a' },
      data: { weeks: 3, endDate: dateOnly('2026-11-22'), closeRequestedAt: WEDNESDAY_WEEK3 },
    });
    expect(result).toMatchObject({
      id: 'champ-a',
      status: ChallengeStatus.ACTIVE,
      weeks: 3,
      endDate: '2026-11-22',
      closeRequestedAt: WEDNESDAY_WEEK3,
      closesAt: new Date('2026-11-23T00:00:00.000Z'),
    });
  });

  it('CAMP-67 closes with 1 week when ended early in the first week', async () => {
    prisma.challenge.findUnique.mockResolvedValue(eightWeeks({ startDate: dateOnly('2026-11-16'), endDate: dateOnly('2027-01-10') }));

    const result = await requestEarlyClose(prisma, TRAINER_USER_ID, 'champ-a', WEDNESDAY_WEEK3);

    expect(prisma.challenge.update).toHaveBeenCalledWith({
      where: { id: 'champ-a' },
      data: { weeks: 1, endDate: dateOnly('2026-11-22'), closeRequestedAt: WEDNESDAY_WEEK3 },
    });
    expect(result).toMatchObject({ weeks: 1, endDate: '2026-11-22' });
  });

  it('CAMP-45 answers 409 challenge.notClosable when the championship is not running or not weekly', async () => {
    const notClosable = [
      eightWeeks({ startDate: dateOnly('2026-11-23'), endDate: dateOnly('2027-01-17') }),
      eightWeeks({ closedAt: new Date('2026-11-16T00:10:00.000Z') }),
      eightWeeks({ cancelledAt: new Date('2026-11-17T10:00:00.000Z') }),
      eightWeeks({ format: 'dates' }),
    ];

    for (const record of notClosable) {
      prisma.challenge.findUnique.mockResolvedValueOnce(record);
      await expect(requestEarlyClose(prisma, TRAINER_USER_ID, 'champ-a', WEDNESDAY_WEEK3)).rejects.toMatchObject({
        httpStatus: 409,
        error: ChallengeErrorCode.CHALLENGE_NOT_CLOSABLE,
        messageCode: ChallengeMessageCode.CHALLENGE_NOT_CLOSABLE,
      });
    }
    expect(prisma.challenge.update).not.toHaveBeenCalled();
  });

  it('CAMP-42 answers 409 challenge.notClosable after the last week ended and before the job closed it', async () => {
    prisma.challenge.findUnique.mockResolvedValue(championship());
    const mondayAfterTheEnd = new Date('2026-11-16T13:00:00.000Z');

    await expect(requestEarlyClose(prisma, TRAINER_USER_ID, 'champ-a', mondayAfterTheEnd)).rejects.toMatchObject({
      httpStatus: 409,
      error: ChallengeErrorCode.CHALLENGE_NOT_CLOSABLE,
      messageCode: ChallengeMessageCode.CHALLENGE_NOT_CLOSABLE,
    });
    expect(prisma.challenge.update).not.toHaveBeenCalled();
  });

  it('CAMP-65 answers 403 when the championship belongs to another trainer', async () => {
    prisma.challenge.findUnique.mockResolvedValue(eightWeeks({ trainerId: 'other-trainer' }));

    await expect(requestEarlyClose(prisma, TRAINER_USER_ID, 'champ-a', WEDNESDAY_WEEK3)).rejects.toMatchObject({
      httpStatus: 403,
      messageCode: ChallengeMessageCode.CHALLENGE_FORBIDDEN_NOT_OWNER,
    });
    expect(prisma.challenge.update).not.toHaveBeenCalled();
  });
});
