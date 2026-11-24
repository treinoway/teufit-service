import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChallengeErrorCode, ChallengeFormat, ChallengeVisibility } from '../../src/constants/challenge.js';
import { AppearAs, CONSISTENCY_PRIVACY_TERM_VERSION } from '../../src/constants/consistency-ranking.js';
import { PointAction } from '../../src/constants/gamification.js';
import { getConfig } from '../../src/services/consistency-config-service.js';

vi.mock('../../src/services/consistency-config-service.js', () => ({ getConfig: vi.fn() }));

// ─── Prisma mock ───────────────────────────────────────────────────────────────

const mockPrisma = {
  trainer: { findUnique: vi.fn() },
  challenge: { findUnique: vi.fn() },
  challengeParticipant: { findUnique: vi.fn(), findMany: vi.fn() },
  pointTransaction: { groupBy: vi.fn(), findMany: vi.fn() },
  user: { findMany: vi.fn() },
  consistencyPrivacyPref: { findMany: vi.fn() },
};

import {
  getChallengeRankingForTrainer,
  getChallengeRankingForStudent,
} from '../../src/services/challenge-ranking-service.js';

const TRAINER_ID = 'trainer-record-uuid';
const TRAINER_USER_ID = 'trainer-user-uuid';
const STUDENT_ID_1 = 'student-uuid-1';
const STUDENT_ID_2 = 'student-uuid-2';
const CHALLENGE_ID = 'challenge-uuid-1';

// Wednesday 2026-01-21 12:00 in Sao Paulo; the week started Monday 2026-01-19 00:00 there (03:00 UTC)
const NOW = new Date('2026-01-21T15:00:00Z');

// Whether a stored transaction matches a Prisma where (studentId in, action equals or in, createdAt range)
function matches(row, where) {
  if (where.studentId?.in && !where.studentId.in.includes(row.studentId)) return false;
  if (typeof where.action === 'string' && row.action !== where.action) return false;
  if (where.action?.in && !where.action.in.includes(row.action)) return false;
  if (where.createdAt?.gte && row.createdAt < where.createdAt.gte) return false;
  if (where.createdAt?.lt && row.createdAt >= where.createdAt.lt) return false;
  return true;
}

// Serves groupBy and findMany of pointTransaction from an in-memory list, as Postgres would
function storeTransactions(transactions) {
  mockPrisma.pointTransaction.findMany.mockImplementation(async ({ where }) => transactions.filter((row) => matches(row, where)));
  mockPrisma.pointTransaction.groupBy.mockImplementation(async ({ by, where }) => {
    const groups = new Map();
    for (const row of transactions.filter((candidate) => matches(candidate, where))) {
      const key = by.map((field) => row[field]).join('|');
      const group = groups.get(key) ?? { ...Object.fromEntries(by.map((field) => [field, row[field]])), rows: [] };
      group.rows.push(row);
      groups.set(key, group);
    }
    return [...groups.values()].map(({ rows, ...keys }) => ({
      ...keys,
      _sum: { points: rows.reduce((sum, row) => sum + row.points, 0) },
      _count: { _all: rows.length },
      _min: { createdAt: new Date(Math.min(...rows.map((row) => row.createdAt.getTime()))) },
    }));
  });
}

// Stored point transaction of a student
const transaction = (studentId, action, points, iso) => ({ studentId, action, points, createdAt: new Date(iso) });

// Alice: three workouts this week on three Sao Paulo days (one late on the 20th, already the 21st in UTC); Bob: an older workout, one on Sunday night in Sao Paulo (Monday in UTC) and a bonus
function arrangeXpScenario() {
  storeTransactions([
    transaction(STUDENT_ID_1, PointAction.WORKOUT_COMPLETED, 10, '2025-12-31T12:00:00Z'),
    transaction(STUDENT_ID_1, PointAction.DAILY_CHECKIN, 2, '2026-01-05T12:00:00Z'),
    transaction(STUDENT_ID_1, PointAction.EVOLUTION_RECORD, 15, '2026-01-18T12:00:00Z'),
    transaction(STUDENT_ID_1, PointAction.WORKOUT_COMPLETED, 10, '2026-01-19T12:00:00Z'),
    transaction(STUDENT_ID_1, PointAction.WORKOUT_COMPLETED, 10, '2026-01-21T01:00:00Z'),
    transaction(STUDENT_ID_1, PointAction.WORKOUT_COMPLETED, 10, '2026-01-21T13:00:00Z'),
    transaction(STUDENT_ID_2, PointAction.WORKOUT_COMPLETED, 10, '2026-01-10T12:00:00Z'),
    transaction(STUDENT_ID_2, PointAction.WORKOUT_COMPLETED, 10, '2026-01-19T02:00:00Z'),
    transaction(STUDENT_ID_2, PointAction.TRAINER_BONUS, 30, '2026-01-20T12:00:00Z'),
  ]);
  mockPrisma.challengeParticipant.findMany.mockResolvedValue([{ studentId: STUDENT_ID_1 }, { studentId: STUDENT_ID_2 }]);
  mockPrisma.user.findMany.mockResolvedValue([
    { id: STUDENT_ID_1, firstName: 'Alice', lastName: 'Smith', avatarUrl: null },
    { id: STUDENT_ID_2, firstName: 'Bob', lastName: 'Jones', avatarUrl: null },
  ]);
}

const ALICE = 'student-alice';
const BRUNO = 'student-bruno';
const CARLA = 'student-carla';
const DUDA = 'student-duda';
const EVA = 'student-eva';
const FABIO = 'student-fabio';

// Stored user of a participant, adult unless a birth date is given
const participantUser = (id, firstName, lastName, birthDate = '1990-05-10') => ({
  id, firstName, lastName, avatarUrl: `https://cdn/${firstName.toLowerCase()}.png`, birthDate: new Date(`${birthDate}T00:00:00Z`),
});

// Stored privacy choice of a student, under the current term unless another is given
const privacyPref = (studentId, appearAs, termVersion = CONSISTENCY_PRIVACY_TERM_VERSION) => ({
  studentId, appearAs, termVersion, acceptedAt: new Date('2026-01-02T12:00:00Z'),
});

// Points 90 Bruno (name), 80 Carla (no answer), 70 Alice (viewer), 60 Duda (15, name), 50 Eva (anonymous), 40 Fabio (outdated term)
function arrangeWeeklyPointsScenario() {
  const points = [[BRUNO, 90], [CARLA, 80], [ALICE, 70], [DUDA, 60], [EVA, 50], [FABIO, 40]];
  mockPrisma.challengeParticipant.findUnique.mockResolvedValue({ challengeId: CHALLENGE_ID, studentId: ALICE });
  mockPrisma.challengeParticipant.findMany.mockResolvedValue(points.map(([studentId]) => ({ studentId })));
  storeTransactions(points.map(([studentId, total], index) => transaction(studentId, PointAction.WORKOUT_COMPLETED, total, `2026-01-0${index + 2}T12:00:00Z`)));
  mockPrisma.user.findMany.mockResolvedValue([
    participantUser(ALICE, 'Alice', 'Smith'), participantUser(BRUNO, 'Bruno', 'Costa'), participantUser(CARLA, 'Carla', 'Lima'),
    participantUser(DUDA, 'Duda', 'Melo', '2010-08-01'), participantUser(EVA, 'Eva', 'Rocha'), participantUser(FABIO, 'Fabio', 'Nunes'),
  ]);
  mockPrisma.consistencyPrivacyPref.findMany.mockResolvedValue([
    privacyPref(ALICE, AppearAs.ANONYMOUS), privacyPref(BRUNO, AppearAs.NAME), privacyPref(DUDA, AppearAs.NAME),
    privacyPref(EVA, AppearAs.ANONYMOUS), privacyPref(FABIO, AppearAs.NAME, '2025-01-v0'),
  ]);
}

const makeChallengeRecord = (overrides = {}) => ({
  id: CHALLENGE_ID,
  trainerId: TRAINER_ID,
  name: 'Test Challenge',
  startDate: new Date(Date.UTC(2026, 0, 1, 12, 0, 0)),
  endDate: new Date(Date.UTC(2026, 0, 31, 12, 0, 0)),
  cancelledAt: null,
  anonymousRanking: false,
  ...overrides,
});

describe('challenge-ranking-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.trainer.findUnique.mockResolvedValue({ id: TRAINER_ID });
    mockPrisma.challengeParticipant.findMany.mockResolvedValue([]);
    mockPrisma.pointTransaction.groupBy.mockResolvedValue([]);
    mockPrisma.user.findMany.mockResolvedValue([]);
    mockPrisma.pointTransaction.findMany.mockResolvedValue([]);
    getConfig.mockResolvedValue({ timeZone: 'America/Sao_Paulo' });
  });

  // ─── getChallengeRankingForTrainer ─────────────────────────────────────────

  describe('getChallengeRankingForTrainer', () => {
    it('reads anonymousRanking from the challenge, not from GamificationConfig', async () => {
      const challenge = makeChallengeRecord({ anonymousRanking: true });
      mockPrisma.challenge.findUnique.mockResolvedValue(challenge);
      mockPrisma.challengeParticipant.findMany.mockResolvedValue([
        { studentId: STUDENT_ID_1 },
        { studentId: STUDENT_ID_2 },
      ]);
      mockPrisma.pointTransaction.groupBy.mockResolvedValue([
        { studentId: STUDENT_ID_1, _sum: { points: 100 }, _min: { createdAt: new Date('2026-01-05T10:00:00Z') } },
        { studentId: STUDENT_ID_2, _sum: { points: 80 }, _min: { createdAt: new Date('2026-01-05T11:00:00Z') } },
      ]);
      mockPrisma.user.findMany.mockResolvedValue([
        { id: STUDENT_ID_1, firstName: 'Alice', lastName: 'Smith', avatarUrl: null },
        { id: STUDENT_ID_2, firstName: 'Bob', lastName: 'Jones', avatarUrl: null },
      ]);

      const entries = await getChallengeRankingForTrainer({
        prisma: mockPrisma,
        trainerUserId: TRAINER_USER_ID,
        challengeId: CHALLENGE_ID,
      });

      // anonymousRanking=true from challenge: trainer sees full names (requestingStudentId=null)
      // When requestingStudentId is null, trainer always sees anonymised names
      expect(entries[0].firstName).toBe('Aluno #1');
      expect(entries[0].lastName).toBeNull();
      expect(entries[1].firstName).toBe('Aluno #2');
    });

    it('shows real names when challenge anonymousRanking is false', async () => {
      const challenge = makeChallengeRecord({ anonymousRanking: false });
      mockPrisma.challenge.findUnique.mockResolvedValue(challenge);
      mockPrisma.challengeParticipant.findMany.mockResolvedValue([
        { studentId: STUDENT_ID_1 },
      ]);
      mockPrisma.pointTransaction.groupBy.mockResolvedValue([
        { studentId: STUDENT_ID_1, _sum: { points: 50 }, _min: { createdAt: new Date('2026-01-05T10:00:00Z') } },
      ]);
      mockPrisma.user.findMany.mockResolvedValue([
        { id: STUDENT_ID_1, firstName: 'Alice', lastName: 'Smith', avatarUrl: null },
      ]);

      const entries = await getChallengeRankingForTrainer({
        prisma: mockPrisma,
        trainerUserId: TRAINER_USER_ID,
        challengeId: CHALLENGE_ID,
      });

      expect(entries[0].firstName).toBe('Alice');
      expect(entries[0].lastName).toBe('Smith');
    });

    it('CPD-38 returns workouts, bonus points, points this week and streak days per entry', async () => {
      mockPrisma.challenge.findUnique.mockResolvedValue(makeChallengeRecord());
      arrangeXpScenario();

      const entries = await getChallengeRankingForTrainer({
        prisma: mockPrisma,
        trainerUserId: TRAINER_USER_ID,
        challengeId: CHALLENGE_ID,
        now: NOW,
      });

      expect(entries.map(({ studentId, position, points, workouts, bonusPoints, pointsThisWeek, streakDays }) => (
        { studentId, position, points, workouts, bonusPoints, pointsThisWeek, streakDays }
      ))).toEqual([
        { studentId: STUDENT_ID_2, position: 1, points: 50, workouts: 2, bonusPoints: 30, pointsThisWeek: 30, streakDays: 0 },
        { studentId: STUDENT_ID_1, position: 2, points: 47, workouts: 3, bonusPoints: 0, pointsThisWeek: 30, streakDays: 3 },
      ]);
    });

    it('CPD-38 counts the streak up to yesterday when there is no workout today', async () => {
      mockPrisma.challenge.findUnique.mockResolvedValue(makeChallengeRecord());
      mockPrisma.challengeParticipant.findMany.mockResolvedValue([{ studentId: STUDENT_ID_1 }]);
      mockPrisma.user.findMany.mockResolvedValue([{ id: STUDENT_ID_1, firstName: 'Alice', lastName: 'Smith', avatarUrl: null }]);
      storeTransactions([
        transaction(STUDENT_ID_1, PointAction.WORKOUT_COMPLETED, 10, '2026-01-19T12:00:00Z'),
        transaction(STUDENT_ID_1, PointAction.WORKOUT_COMPLETED, 10, '2026-01-20T12:00:00Z'),
      ]);

      const [entry] = await getChallengeRankingForTrainer({
        prisma: mockPrisma,
        trainerUserId: TRAINER_USER_ID,
        challengeId: CHALLENGE_ID,
        now: NOW,
      });

      expect(entry.streakDays).toBe(2);
    });

    it('throws TRAINER_PROFILE_MISSING when trainer not found', async () => {
      mockPrisma.trainer.findUnique.mockResolvedValue(null);

      await expect(
        getChallengeRankingForTrainer({
          prisma: mockPrisma,
          trainerUserId: TRAINER_USER_ID,
          challengeId: CHALLENGE_ID,
        }),
      ).rejects.toMatchObject({
        httpStatus: 404,
        error: ChallengeErrorCode.TRAINER_PROFILE_MISSING,
      });
    });

    it('throws CHALLENGE_NOT_FOUND when challenge does not exist', async () => {
      mockPrisma.challenge.findUnique.mockResolvedValue(null);

      await expect(
        getChallengeRankingForTrainer({
          prisma: mockPrisma,
          trainerUserId: TRAINER_USER_ID,
          challengeId: CHALLENGE_ID,
        }),
      ).rejects.toMatchObject({
        httpStatus: 404,
        error: ChallengeErrorCode.CHALLENGE_NOT_FOUND,
      });
    });
  });

  // ─── getChallengeRankingForStudent ─────────────────────────────────────────

  describe('getChallengeRankingForStudent', () => {
    it('reads anonymousRanking from the challenge record, not from GamificationConfig', async () => {
      const challenge = makeChallengeRecord({ anonymousRanking: true });
      mockPrisma.challenge.findUnique.mockResolvedValue(challenge);
      mockPrisma.challengeParticipant.findUnique.mockResolvedValue({
        challengeId: CHALLENGE_ID,
        studentId: STUDENT_ID_1,
      });
      mockPrisma.challengeParticipant.findMany.mockResolvedValue([
        { studentId: STUDENT_ID_1 },
        { studentId: STUDENT_ID_2 },
      ]);
      mockPrisma.pointTransaction.groupBy.mockResolvedValue([
        { studentId: STUDENT_ID_1, _sum: { points: 100 }, _min: { createdAt: new Date('2026-01-05T10:00:00Z') } },
        { studentId: STUDENT_ID_2, _sum: { points: 80 }, _min: { createdAt: new Date('2026-01-05T11:00:00Z') } },
      ]);
      mockPrisma.user.findMany.mockResolvedValue([
        { id: STUDENT_ID_1, firstName: 'Alice', lastName: 'Smith', avatarUrl: null },
        { id: STUDENT_ID_2, firstName: 'Bob', lastName: 'Jones', avatarUrl: null },
      ]);

      const result = await getChallengeRankingForStudent({
        prisma: mockPrisma,
        studentId: STUDENT_ID_1,
        challengeId: CHALLENGE_ID,
      });

      // The requester (STUDENT_ID_1) sees their own real name
      const myEntry = result.entries.find((e) => e.studentId === STUDENT_ID_1);
      expect(myEntry.firstName).toBe('Alice');
      // Other students are anonymised
      const otherEntry = result.entries.find((e) => e.studentId === STUDENT_ID_2);
      expect(otherEntry.firstName).toBe('Aluno #2');
      expect(otherEntry.lastName).toBeNull();
    });

    it('shows all real names when challenge anonymousRanking is false', async () => {
      const challenge = makeChallengeRecord({ anonymousRanking: false });
      mockPrisma.challenge.findUnique.mockResolvedValue(challenge);
      mockPrisma.challengeParticipant.findUnique.mockResolvedValue({
        challengeId: CHALLENGE_ID,
        studentId: STUDENT_ID_1,
      });
      mockPrisma.challengeParticipant.findMany.mockResolvedValue([
        { studentId: STUDENT_ID_1 },
        { studentId: STUDENT_ID_2 },
      ]);
      mockPrisma.pointTransaction.groupBy.mockResolvedValue([
        { studentId: STUDENT_ID_1, _sum: { points: 100 }, _min: { createdAt: new Date('2026-01-05T10:00:00Z') } },
        { studentId: STUDENT_ID_2, _sum: { points: 80 }, _min: { createdAt: new Date('2026-01-05T11:00:00Z') } },
      ]);
      mockPrisma.user.findMany.mockResolvedValue([
        { id: STUDENT_ID_1, firstName: 'Alice', lastName: 'Smith', avatarUrl: null },
        { id: STUDENT_ID_2, firstName: 'Bob', lastName: 'Jones', avatarUrl: null },
      ]);

      const result = await getChallengeRankingForStudent({
        prisma: mockPrisma,
        studentId: STUDENT_ID_1,
        challengeId: CHALLENGE_ID,
      });

      expect(result.entries[0].firstName).toBe('Alice');
      expect(result.entries[1].firstName).toBe('Bob');
    });

    it('returns myPosition and myPoints for the requesting student', async () => {
      const challenge = makeChallengeRecord({ anonymousRanking: false });
      mockPrisma.challenge.findUnique.mockResolvedValue(challenge);
      mockPrisma.challengeParticipant.findUnique.mockResolvedValue({
        challengeId: CHALLENGE_ID,
        studentId: STUDENT_ID_1,
      });
      mockPrisma.challengeParticipant.findMany.mockResolvedValue([
        { studentId: STUDENT_ID_1 },
      ]);
      mockPrisma.pointTransaction.groupBy.mockResolvedValue([
        { studentId: STUDENT_ID_1, _sum: { points: 75 }, _min: { createdAt: new Date('2026-01-05T10:00:00Z') } },
      ]);
      mockPrisma.user.findMany.mockResolvedValue([
        { id: STUDENT_ID_1, firstName: 'Alice', lastName: 'Smith', avatarUrl: null },
      ]);

      const result = await getChallengeRankingForStudent({
        prisma: mockPrisma,
        studentId: STUDENT_ID_1,
        challengeId: CHALLENGE_ID,
      });

      expect(result.myPosition).toBe(1);
      expect(result.myPoints).toBe(75);
    });

    it('CPD-38 returns the student ranking without workouts, bonus points, points this week or streak days', async () => {
      mockPrisma.challenge.findUnique.mockResolvedValue(makeChallengeRecord());
      mockPrisma.challengeParticipant.findUnique.mockResolvedValue({ challengeId: CHALLENGE_ID, studentId: STUDENT_ID_1 });
      arrangeXpScenario();

      const result = await getChallengeRankingForStudent({
        prisma: mockPrisma,
        studentId: STUDENT_ID_1,
        challengeId: CHALLENGE_ID,
      });

      expect(result.entries).toEqual([
        { position: 1, studentId: STUDENT_ID_2, firstName: 'Bob', lastName: 'Jones', avatarUrl: null, points: 50 },
        { position: 2, studentId: STUDENT_ID_1, firstName: 'Alice', lastName: 'Smith', avatarUrl: null, points: 47 },
      ]);
    });

    it('APP-74 applies the constancy privacy and visibility to the points ranking of a weekly championship', async () => {
      arrangeWeeklyPointsScenario();
      const read = (overrides, studentId = ALICE) => {
        mockPrisma.challenge.findUnique.mockResolvedValue(makeChallengeRecord({ format: ChallengeFormat.WEEKS, visibility: ChallengeVisibility.FULL, ...overrides }));
        return getChallengeRankingForStudent({ prisma: mockPrisma, studentId, challengeId: CHALLENGE_ID, now: NOW });
      };

      const full = await read({});
      expect(full.entries.map(({ studentId, ...shown }) => shown)).toEqual([
        { position: 1, firstName: 'Bruno', lastName: 'Costa', avatarUrl: 'https://cdn/bruno.png', points: 90, isMe: false },
        { position: 2, firstName: 'Aluno do time', lastName: null, avatarUrl: null, points: 80, isMe: false },
        { position: 3, firstName: 'Alice', lastName: 'Smith', avatarUrl: 'https://cdn/alice.png', points: 70, isMe: true },
        { position: 4, firstName: 'Aluno do time', lastName: null, avatarUrl: null, points: 60, isMe: false },
        { position: 5, firstName: 'Aluno do time', lastName: null, avatarUrl: null, points: 50, isMe: false },
        { position: 6, firstName: 'Aluno do time', lastName: null, avatarUrl: null, points: 40, isMe: false },
      ]);
      const peerIds = full.entries.filter((entry) => !entry.isMe).map((entry) => entry.studentId);
      expect(full.entries.find((entry) => entry.isMe).studentId).toBe(ALICE);
      expect(peerIds.filter((id) => [BRUNO, CARLA, DUDA, EVA, FABIO].includes(id))).toEqual([]);
      expect(new Set(peerIds).size).toBe(5);
      expect(full).toMatchObject({ myPosition: 3, myPoints: 70 });

      const anonymous = await read({ anonymousRanking: true });
      expect(anonymous.entries.filter((entry) => !entry.isMe).map((entry) => [entry.firstName, entry.avatarUrl])).toEqual(
        Array.from({ length: 5 }, () => ['Aluno do time', null]),
      );
      expect(anonymous.entries.find((entry) => entry.isMe).firstName).toBe('Alice');

      const positionOnly = await read({ visibility: ChallengeVisibility.POSITION });
      expect(positionOnly).toEqual({
        entries: [{ position: 3, studentId: ALICE, firstName: 'Alice', lastName: 'Smith', avatarUrl: 'https://cdn/alice.png', points: 70, isMe: true }],
        myPosition: 3,
        myPoints: 70,
      });

      expect(await read({ visibility: ChallengeVisibility.OFF })).toEqual({ entries: [], myPosition: null, myPoints: 70 });
      expect(await read({}, DUDA)).toEqual({ entries: [], myPosition: null, myPoints: 60 });
    });

    it('APP-74 keeps Aluno #N and the ids in the points ranking of a dates championship', async () => {
      arrangeWeeklyPointsScenario();
      mockPrisma.challenge.findUnique.mockResolvedValue(makeChallengeRecord({ format: ChallengeFormat.DATES, anonymousRanking: true }));

      const result = await getChallengeRankingForStudent({ prisma: mockPrisma, studentId: ALICE, challengeId: CHALLENGE_ID, now: NOW });

      expect(result.entries.map((entry) => [entry.studentId, entry.firstName])).toEqual([
        [BRUNO, 'Aluno #1'], [CARLA, 'Aluno #2'], [ALICE, 'Alice'], [DUDA, 'Aluno #4'], [EVA, 'Aluno #5'], [FABIO, 'Aluno #6'],
      ]);
    });

    it('throws CHALLENGE_FORBIDDEN_NOT_OWNER when student is not a participant', async () => {
      const challenge = makeChallengeRecord();
      mockPrisma.challenge.findUnique.mockResolvedValue(challenge);
      mockPrisma.challengeParticipant.findUnique.mockResolvedValue(null);

      await expect(
        getChallengeRankingForStudent({
          prisma: mockPrisma,
          studentId: STUDENT_ID_1,
          challengeId: CHALLENGE_ID,
        }),
      ).rejects.toMatchObject({
        httpStatus: 403,
        error: ChallengeErrorCode.CHALLENGE_FORBIDDEN_NOT_OWNER,
      });
    });
  });
});
