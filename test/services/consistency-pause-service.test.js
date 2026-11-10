import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pauseReasonsFor, pauseWeek, pausesFor, resumeWeek } from '../../src/services/consistency-pause-service.js';
import { liveAverage, seasonFigures } from '../../src/helpers/consistency-math.js';
import { ConsistencyErrorCode, ConsistencyMessageCode, WeekStatus } from '../../src/constants/consistency-ranking.js';

const TRAINER_ID = 'trainer-1';
const STUDENT_ID = 'student-1';
// Wednesday 2026-11-11 12:00 in Sao Paulo (UTC-3); the current Monday is 2026-11-09
const NOW = new Date('2026-11-11T15:00:00Z');
const CURRENT_WEEK = { year: 2026, month: 11, day: 9 };
const CURRENT_WEEK_DATE = new Date(Date.UTC(2026, 10, 9));
const PAST_WEEK = { year: 2026, month: 11, day: 2 };
const TWELVE_AHEAD = { year: 2027, month: 2, day: 1 };
const THIRTEEN_AHEAD = { year: 2027, month: 2, day: 8 };
const SEASON_ID = 'season-1';
const WEEK_BEFORE = { year: 2026, month: 11, day: 2 };
const WEEK_AFTER = { year: 2026, month: 11, day: 16 };

// Builds a prisma mock with the given link, close mark and stored pause rows
function createPrisma({ linked = true, closeRow = null, rows = [] } = {}) {
  const sameValue = (a, b) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);
  return {
    trainerStudent: { findFirst: vi.fn().mockResolvedValue(linked ? { id: 'link-1' } : null) },
    consistencyScoringRule: { findFirst: vi.fn().mockResolvedValue(null) },
    consistencyWeekClose: { findFirst: vi.fn().mockResolvedValue(closeRow) },
    consistencyWeekPause: {
      findFirst: vi.fn(async ({ where }) => rows.find((row) => Object.entries(where).every(([key, value]) => sameValue(row[key], value))) ?? null),
      findMany: vi.fn().mockResolvedValue(rows),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

// Stored result of a week as the close writes it: a paused student gets no score
function closedResult(weekKey, score, pauses) {
  const paused = pauses.get(weekKey).students.get(STUDENT_ID) === true;
  return { seasonId: SEASON_ID, status: paused ? WeekStatus.PAUSED : WeekStatus.VALID, score: paused ? null : score };
}

// Asserts no pause row was created, changed or removed
function expectNoWrites(prisma) {
  expect(prisma.consistencyWeekPause.updateMany).not.toHaveBeenCalled();
  expect(prisma.consistencyWeekPause.create).not.toHaveBeenCalled();
  expect(prisma.consistencyWeekPause.deleteMany).not.toHaveBeenCalled();
}

// Runs the action expecting a rejection and returns the thrown error
async function rejection(action) {
  const error = await action().catch((caught) => caught);
  expect(error).toBeInstanceOf(Error);
  return error;
}

// Asserts the 409 contract of a non-editable week
function expectNotEditable(error) {
  expect(error.httpStatus).toBe(409);
  expect(error.error).toBe(ConsistencyErrorCode.PAUSE_WEEK_NOT_EDITABLE);
  expect(error.messageCode).toBe(ConsistencyMessageCode.PAUSE_WEEK_NOT_EDITABLE);
}

describe('pauseWeek', () => {
  let prisma;
  beforeEach(() => {
    prisma = createPrisma();
  });

  it('RANK-41 pauses a student week', async () => {
    const result = await pauseWeek(prisma, TRAINER_ID, { weekStart: CURRENT_WEEK, studentId: STUDENT_ID, reason: 'injury' }, NOW);

    expect(prisma.trainerStudent.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { trainerId: TRAINER_ID, studentId: STUDENT_ID } }));
    expect(prisma.consistencyWeekPause.create).toHaveBeenCalledWith({
      data: { trainerId: TRAINER_ID, studentId: STUDENT_ID, weekStart: CURRENT_WEEK_DATE, paused: true, reason: 'injury' },
    });
    expect(result).toEqual({ weekStart: '2026-11-09', studentId: STUDENT_ID, paused: true, reason: 'injury' });

    prisma.consistencyWeekPause.findMany.mockResolvedValue([prisma.consistencyWeekPause.create.mock.calls[0][0].data]);

    const pauses = await pausesFor(prisma, TRAINER_ID, [WEEK_BEFORE, CURRENT_WEEK, WEEK_AFTER]);
    const results = [
      closedResult('2026-11-16', 100, pauses),
      closedResult('2026-11-09', 40, pauses),
      closedResult('2026-11-02', 100, pauses),
    ];
    const figures = seasonFigures(results, SEASON_ID);

    expect(results.map((row) => row.status)).toEqual([WeekStatus.VALID, WeekStatus.PAUSED, WeekStatus.VALID]);
    expect(liveAverage(figures.scores, null).toNumber()).toBe(100);
    expect(figures.streak).toBe(2);
  });

  it('RANK-41 is idempotent and flips a reactivated student back', async () => {
    prisma.consistencyWeekPause.updateMany.mockResolvedValue({ count: 1 });

    await pauseWeek(prisma, TRAINER_ID, { weekStart: CURRENT_WEEK, studentId: STUDENT_ID }, NOW);

    expect(prisma.consistencyWeekPause.updateMany).toHaveBeenCalledWith({
      where: { trainerId: TRAINER_ID, studentId: STUDENT_ID, weekStart: CURRENT_WEEK_DATE },
      data: { paused: true, reason: null },
    });
    expect(prisma.consistencyWeekPause.create).not.toHaveBeenCalled();
  });

  it('RANK-41 survives a concurrent insert by updating after the unique violation', async () => {
    prisma.consistencyWeekPause.create.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
    prisma.consistencyWeekPause.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });

    await expect(pauseWeek(prisma, TRAINER_ID, { weekStart: CURRENT_WEEK, studentId: STUDENT_ID }, NOW)).resolves.toMatchObject({ paused: true });
    expect(prisma.consistencyWeekPause.updateMany).toHaveBeenCalledTimes(2);
  });

  it('RANK-42 pauses the whole team', async () => {
    const result = await pauseWeek(prisma, TRAINER_ID, { weekStart: CURRENT_WEEK }, NOW);

    expect(prisma.trainerStudent.findFirst).not.toHaveBeenCalled();
    expect(prisma.consistencyWeekPause.create).toHaveBeenCalledWith({
      data: { trainerId: TRAINER_ID, studentId: null, weekStart: CURRENT_WEEK_DATE, paused: true, reason: null },
    });
    expect(prisma.consistencyWeekPause.deleteMany).toHaveBeenCalledWith({
      where: { trainerId: TRAINER_ID, studentId: { not: null }, weekStart: CURRENT_WEEK_DATE, paused: false },
    });
    expect(result).toEqual({ weekStart: '2026-11-09', studentId: null, paused: true, reason: null });
  });

  it('RANK-44 rejects closed weeks and weeks beyond 12 ahead with 409', async () => {
    expectNotEditable(await rejection(() => pauseWeek(prisma, TRAINER_ID, { weekStart: PAST_WEEK }, NOW)));

    const closedMark = createPrisma({ closeRow: { id: 'close-1' } });
    expectNotEditable(await rejection(() => pauseWeek(closedMark, TRAINER_ID, { weekStart: CURRENT_WEEK, studentId: STUDENT_ID }, NOW)));

    const afterClose = new Date('2026-11-16T00:30:00Z');
    expectNotEditable(await rejection(() => pauseWeek(prisma, TRAINER_ID, { weekStart: CURRENT_WEEK }, afterClose)));

    expectNotEditable(await rejection(() => pauseWeek(prisma, TRAINER_ID, { weekStart: THIRTEEN_AHEAD, studentId: STUDENT_ID }, NOW)));

    expectNoWrites(prisma);
    expectNoWrites(closedMark);
  });

  it('RANK-44 allows the current week and exactly 12 weeks ahead', async () => {
    await expect(pauseWeek(prisma, TRAINER_ID, { weekStart: CURRENT_WEEK }, NOW)).resolves.toMatchObject({ paused: true });
    await expect(pauseWeek(prisma, TRAINER_ID, { weekStart: TWELVE_AHEAD }, NOW)).resolves.toMatchObject({ weekStart: '2027-02-01' });
    expect(prisma.consistencyWeekPause.create).toHaveBeenCalledTimes(2);
  });

  it("RANK-46 rejects another trainer's student with 404", async () => {
    const stranger = createPrisma({ linked: false });

    const error = await rejection(() => pauseWeek(stranger, TRAINER_ID, { weekStart: CURRENT_WEEK, studentId: 'someone-else' }, NOW));

    expect(error.httpStatus).toBe(404);
    expect(error.messageCode).toBe('student.notFound');
    expectNoWrites(stranger);
  });
});

describe('resumeWeek', () => {
  const teamPauseRow = { trainerId: TRAINER_ID, studentId: null, weekStart: CURRENT_WEEK_DATE, paused: true };

  it('RANK-43 resumes one student inside a team pause', async () => {
    const prisma = createPrisma({ rows: [teamPauseRow] });

    const result = await resumeWeek(prisma, TRAINER_ID, { weekStart: CURRENT_WEEK, studentId: STUDENT_ID }, NOW);

    expect(prisma.consistencyWeekPause.create).toHaveBeenCalledWith({
      data: { trainerId: TRAINER_ID, studentId: STUDENT_ID, weekStart: CURRENT_WEEK_DATE, paused: false, reason: null },
    });
    expect(prisma.consistencyWeekPause.deleteMany).not.toHaveBeenCalled();
    expect(result).toEqual({ weekStart: '2026-11-09', studentId: STUDENT_ID, paused: false });
  });

  it('RANK-43 flips an existing student row to reactivated inside a team pause', async () => {
    const prisma = createPrisma({ rows: [teamPauseRow] });
    prisma.consistencyWeekPause.updateMany.mockResolvedValue({ count: 1 });

    await resumeWeek(prisma, TRAINER_ID, { weekStart: CURRENT_WEEK, studentId: STUDENT_ID }, NOW);

    expect(prisma.consistencyWeekPause.updateMany).toHaveBeenCalledWith({
      where: { trainerId: TRAINER_ID, studentId: STUDENT_ID, weekStart: CURRENT_WEEK_DATE },
      data: { paused: false },
    });
    expect(prisma.consistencyWeekPause.create).not.toHaveBeenCalled();
  });

  it('RANK-43 removes the own pause row of a student when the team is not paused', async () => {
    const prisma = createPrisma();

    await resumeWeek(prisma, TRAINER_ID, { weekStart: CURRENT_WEEK, studentId: STUDENT_ID }, NOW);

    expect(prisma.consistencyWeekPause.deleteMany).toHaveBeenCalledWith({
      where: { trainerId: TRAINER_ID, studentId: STUDENT_ID, weekStart: CURRENT_WEEK_DATE },
    });
    expect(prisma.consistencyWeekPause.create).not.toHaveBeenCalled();
  });

  it('RANK-43 removes the team pause and the student rows of that week', async () => {
    const prisma = createPrisma();

    const result = await resumeWeek(prisma, TRAINER_ID, { weekStart: CURRENT_WEEK }, NOW);

    expect(prisma.consistencyWeekPause.deleteMany).toHaveBeenCalledWith({ where: { trainerId: TRAINER_ID, weekStart: CURRENT_WEEK_DATE } });
    expect(result).toEqual({ weekStart: '2026-11-09', studentId: null, paused: false });
  });

  it('RANK-44 rejects closed and too-far weeks with 409 and writes nothing', async () => {
    const prisma = createPrisma();

    expectNotEditable(await rejection(() => resumeWeek(prisma, TRAINER_ID, { weekStart: PAST_WEEK }, NOW)));
    expectNotEditable(await rejection(() => resumeWeek(prisma, TRAINER_ID, { weekStart: THIRTEEN_AHEAD, studentId: STUDENT_ID }, NOW)));
    expectNoWrites(prisma);
  });

  it("RANK-46 rejects another trainer's student with 404 and writes nothing", async () => {
    const stranger = createPrisma({ linked: false });

    const error = await rejection(() => resumeWeek(stranger, TRAINER_ID, { weekStart: CURRENT_WEEK, studentId: 'someone-else' }, NOW));

    expect(error.httpStatus).toBe(404);
    expect(error.messageCode).toBe('student.notFound');
    expectNoWrites(stranger);
  });
});

describe('pausesFor', () => {
  it('RANK-42 maps team pauses and student exceptions per week', async () => {
    const nextMonday = new Date(Date.UTC(2026, 10, 16));
    const mondayAfter = new Date(Date.UTC(2026, 10, 23));
    const prisma = createPrisma({
      rows: [
        { studentId: null, weekStart: CURRENT_WEEK_DATE, paused: true },
        { studentId: STUDENT_ID, weekStart: CURRENT_WEEK_DATE, paused: false },
        { studentId: 'student-2', weekStart: nextMonday, paused: true },
      ],
    });

    const result = await pausesFor(prisma, TRAINER_ID, [CURRENT_WEEK, { year: 2026, month: 11, day: 16 }, { year: 2026, month: 11, day: 23 }]);

    expect(prisma.consistencyWeekPause.findMany).toHaveBeenCalledWith({
      where: { trainerId: TRAINER_ID, weekStart: { in: [CURRENT_WEEK_DATE, nextMonday, mondayAfter] } },
    });
    expect(result.get('2026-11-09')).toEqual({ team: true, students: new Map([[STUDENT_ID, false]]) });
    expect(result.get('2026-11-16')).toEqual({ team: false, students: new Map([['student-2', true]]) });
    expect(result.get('2026-11-23')).toEqual({ team: false, students: new Map() });
  });

  it('returns an empty map without querying for no weeks', async () => {
    const prisma = createPrisma();

    expect((await pausesFor(prisma, TRAINER_ID, [])).size).toBe(0);
    expect(prisma.consistencyWeekPause.findMany).not.toHaveBeenCalled();
  });
});

describe('pauseReasonsFor', () => {
  it('PAN-46 returns the reason of the team pause and of each paused student', async () => {
    const prisma = createPrisma({
      rows: [
        { studentId: null, weekStart: CURRENT_WEEK_DATE, paused: true, reason: 'feriado' },
        { studentId: STUDENT_ID, weekStart: CURRENT_WEEK_DATE, paused: true, reason: 'viagem' },
        { studentId: 'student-2', weekStart: CURRENT_WEEK_DATE, paused: true, reason: null },
      ],
    });

    const reasons = await pauseReasonsFor(prisma, TRAINER_ID, CURRENT_WEEK);

    expect(prisma.consistencyWeekPause.findMany).toHaveBeenCalledWith({
      where: { trainerId: TRAINER_ID, weekStart: CURRENT_WEEK_DATE, paused: true },
    });
    expect(reasons).toEqual({ team: 'feriado', students: new Map([[STUDENT_ID, 'viagem'], ['student-2', null]]) });
  });

  it('PAN-46 returns no reason when nothing is paused', async () => {
    const prisma = createPrisma({ rows: [] });

    expect(await pauseReasonsFor(prisma, TRAINER_ID, CURRENT_WEEK)).toEqual({ team: null, students: new Map() });
  });
});
