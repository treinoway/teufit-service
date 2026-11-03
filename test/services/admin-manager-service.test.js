import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppError } from '../../src/errors/app-error.js';
import { Roles } from '../../src/constants/roles.js';
import {
  listUsers,
  getUserOverview,
  listUserStudents,
  listUserTrainers,
  listUserProtocols,
  getProtocolDetail,
  listUserTemplates,
  listUserSessions,
} from '../../src/services/admin-manager-service.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TRAINER_ID = '22222222-2222-4222-8222-222222222222';
const PROTOCOL_ID = '33333333-3333-4333-8333-333333333333';
const STATEMENT_TIMEOUT_CODE = '57014';
const NOT_FOUND_STATUS = 404;
const UNAVAILABLE_STATUS = 503;
const USER_NOT_FOUND = { error: 'NOT_FOUND', messageCode: 'admin.userNotFound' };
const PROTOCOL_NOT_FOUND = { error: 'NOT_FOUND', messageCode: 'admin.protocolNotFound' };
const QUERY_TIMEOUT_MESSAGE_CODE = 'admin.queryTimeout';
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const CREATED_AT = new Date('2026-02-01T10:00:00.000Z');

// ─── Prisma mock ──────────────────────────────────────────────────────────────

const mockAdminDb = {
  user: { findMany: vi.fn(), findUnique: vi.fn(), count: vi.fn() },
  trainer: { findUnique: vi.fn() },
  trainerStudent: { findMany: vi.fn(), count: vi.fn(), aggregate: vi.fn() },
  trainingProtocol: { findMany: vi.fn(), findUnique: vi.fn(), count: vi.fn() },
  trainingTemplate: { findMany: vi.fn(), count: vi.fn() },
  exerciseTemplate: { findMany: vi.fn(), count: vi.fn() },
  workoutSession: { findMany: vi.fn(), count: vi.fn(), aggregate: vi.fn(), findFirst: vi.fn() },
  challenge: { count: vi.fn() },
};

// ─── Fixtures and helpers ─────────────────────────────────────────────────────

// Builds a user row as the list query selects it.
function makeUserRow(overrides = {}) {
  return {
    id: USER_ID,
    firstName: 'Ana',
    lastName: 'Lima',
    email: 'ana@example.com',
    roles: [],
    status: 'active',
    createdAt: CREATED_AT,
    deletedAt: null,
    trainer: null,
    trainers: [],
    _count: { trainers: 0 },
    ...overrides,
  };
}

// Builds a user row that is both a trainer and a student.
function makeTrainerStudentUserRow() {
  return makeUserRow({
    roles: [Roles.TRAINER],
    trainer: { id: TRAINER_ID },
    trainers: [{ id: 'link-1' }],
    _count: { trainers: 1 },
  });
}

// Serializes the where clause so assertions do not depend on how filters are nested.
function whereOf(mockFn) {
  return JSON.stringify(mockFn.mock.calls[0][0].where);
}

// Asserts every call of the mocked query uses select and never include.
function expectSelectOnly(mockFn) {
  expect(mockFn).toHaveBeenCalled();
  for (const [args] of mockFn.mock.calls) {
    expect(args.select).toBeDefined();
    expect(args.include).toBeUndefined();
  }
}

// Builds a Postgres statement-timeout error as a raw pg driver error.
function makePgTimeoutError() {
  return Object.assign(new Error('canceling statement due to statement timeout'), {
    code: STATEMENT_TIMEOUT_CODE,
  });
}

// Builds the error Prisma throws when a driver adapter query hits the statement timeout.
function makePrismaWrappedTimeoutError() {
  return Object.assign(new Error('Raw query failed'), {
    code: 'P2010',
    meta: {
      code: STATEMENT_TIMEOUT_CODE,
      driverAdapterError: {
        cause: { kind: 'postgres', code: STATEMENT_TIMEOUT_CODE, originalCode: STATEMENT_TIMEOUT_CODE },
      },
    },
  });
}

// Builds an error that carries the timeout error as its cause.
function makeCausedTimeoutError() {
  return Object.assign(new Error('query failed'), { cause: makePgTimeoutError() });
}

// Makes every mocked query reject with the given error.
function rejectAllQueries(error) {
  for (const model of Object.values(mockAdminDb)) {
    for (const method of Object.values(model)) {
      method.mockRejectedValue(error);
    }
  }
}

// Makes every mocked query resolve to an empty-ish default.
function resolveDefaults() {
  mockAdminDb.user.findMany.mockResolvedValue([]);
  mockAdminDb.user.count.mockResolvedValue(0);
  mockAdminDb.user.findUnique.mockResolvedValue(makeUserRow());
  mockAdminDb.trainer.findUnique.mockResolvedValue({ id: TRAINER_ID, createdAt: CREATED_AT });
  mockAdminDb.trainerStudent.findMany.mockResolvedValue([]);
  mockAdminDb.trainerStudent.count.mockResolvedValue(0);
  mockAdminDb.trainerStudent.aggregate.mockResolvedValue({ _max: { lastWorkoutAt: null } });
  mockAdminDb.trainingProtocol.findMany.mockResolvedValue([]);
  mockAdminDb.trainingProtocol.count.mockResolvedValue(0);
  mockAdminDb.trainingProtocol.findUnique.mockResolvedValue(null);
  mockAdminDb.trainingTemplate.findMany.mockResolvedValue([]);
  mockAdminDb.trainingTemplate.count.mockResolvedValue(0);
  mockAdminDb.exerciseTemplate.findMany.mockResolvedValue([]);
  mockAdminDb.exerciseTemplate.count.mockResolvedValue(0);
  mockAdminDb.workoutSession.findMany.mockResolvedValue([]);
  mockAdminDb.workoutSession.count.mockResolvedValue(0);
  mockAdminDb.workoutSession.aggregate.mockResolvedValue({ _max: { startedAt: null, finishedAt: null } });
  mockAdminDb.workoutSession.findFirst.mockResolvedValue(null);
  mockAdminDb.challenge.count.mockResolvedValue(0);
}

beforeEach(() => {
  resolveDefaults();
});

// ─── listUsers ────────────────────────────────────────────────────────────────

describe('listUsers', () => {
  describe('pagination', () => {
    it('should return items, total, page and pageSize', async () => {
      mockAdminDb.user.findMany.mockResolvedValue([makeUserRow()]);
      mockAdminDb.user.count.mockResolvedValue(41);

      const result = await listUsers(mockAdminDb, { page: 3, pageSize: 10 });

      expect(result).toMatchObject({ total: 41, page: 3, pageSize: 10 });
      expect(result.items).toHaveLength(1);
    });

    it('should default to page 1 and pageSize 20', async () => {
      const result = await listUsers(mockAdminDb, {});

      expect(result).toMatchObject({ page: DEFAULT_PAGE, pageSize: DEFAULT_PAGE_SIZE });
    });

    it('should translate page and pageSize into skip and take', async () => {
      await listUsers(mockAdminDb, { page: 3, pageSize: 10 });

      expect(mockAdminDb.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 10 }),
      );
    });

    it('should order by createdAt desc then id asc for a stable page order', async () => {
      await listUsers(mockAdminDb, {});

      expect(mockAdminDb.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] }),
      );
    });

    it('should count with the same filter used to list', async () => {
      await listUsers(mockAdminDb, { search: 'ana' });

      expect(JSON.stringify(mockAdminDb.user.count.mock.calls[0][0].where)).toBe(
        whereOf(mockAdminDb.user.findMany),
      );
    });
  });

  describe('query shape', () => {
    it('should use select and never include', async () => {
      await listUsers(mockAdminDb, {});

      expectSelectOnly(mockAdminDb.user.findMany);
    });

    it('should not exclude soft-deleted users', async () => {
      await listUsers(mockAdminDb, {});

      expect(whereOf(mockAdminDb.user.findMany) ?? '').not.toContain('"deletedAt":null');
    });
  });

  describe('item mapping', () => {
    it('should map the documented item fields', async () => {
      mockAdminDb.user.findMany.mockResolvedValue([makeTrainerStudentUserRow()]);

      const { items } = await listUsers(mockAdminDb, {});

      expect(items[0]).toEqual({
        id: USER_ID,
        firstName: 'Ana',
        lastName: 'Lima',
        email: 'ana@example.com',
        roles: [Roles.TRAINER],
        isTrainer: true,
        isStudent: true,
        status: 'active',
        createdAt: CREATED_AT,
        deletedAt: null,
      });
    });

    it('should flag a user without trainer or student links as neither', async () => {
      mockAdminDb.user.findMany.mockResolvedValue([makeUserRow()]);

      const { items } = await listUsers(mockAdminDb, {});

      expect(items[0]).toMatchObject({ isTrainer: false, isStudent: false });
    });

    it('should include soft-deleted users flagged with deletedAt', async () => {
      const deletedAt = new Date('2026-03-01T00:00:00.000Z');
      mockAdminDb.user.findMany.mockResolvedValue([makeUserRow({ deletedAt })]);

      const { items } = await listUsers(mockAdminDb, {});

      expect(items[0].deletedAt).toEqual(deletedAt);
    });
  });

  describe('kind filter', () => {
    it('should filter students by having a TrainerStudent row', async () => {
      await listUsers(mockAdminDb, { kind: 'student' });

      expect(whereOf(mockAdminDb.user.findMany)).toContain('"trainers":{"some":{}}');
    });

    it('should not filter students by role since no student role exists', async () => {
      await listUsers(mockAdminDb, { kind: 'student' });

      expect(whereOf(mockAdminDb.user.findMany)).not.toContain('student"');
    });

    it.each([Roles.TRAINER, Roles.ADMIN, Roles.NUTRITIONIST])(
      'should filter %s by role membership',
      async (kind) => {
        await listUsers(mockAdminDb, { kind });

        expect(whereOf(mockAdminDb.user.findMany)).toContain(`"roles":{"has":"${kind}"}`);
      },
    );

    it('should apply no kind restriction when kind is omitted', async () => {
      await listUsers(mockAdminDb, {});

      const where = mockAdminDb.user.findMany.mock.calls[0][0].where;
      expect(JSON.stringify(where ?? {})).not.toContain('roles');
    });
  });

  describe('search', () => {
    it('should AND one clause per whitespace-separated token', async () => {
      await listUsers(mockAdminDb, { search: 'ana lima' });

      const serialized = whereOf(mockAdminDb.user.findMany);
      expect(serialized).toContain('"contains":"ana"');
      expect(serialized).toContain('"contains":"lima"');
    });

    it('should not search for the whole phrase as a single token', async () => {
      await listUsers(mockAdminDb, { search: 'ana lima' });

      expect(whereOf(mockAdminDb.user.findMany)).not.toContain('"contains":"ana lima"');
    });

    it('should match case-insensitively on first name, last name and email', async () => {
      await listUsers(mockAdminDb, { search: 'ana' });

      const serialized = whereOf(mockAdminDb.user.findMany);
      expect(serialized).toContain('"mode":"insensitive"');
      expect(serialized).toContain('firstName');
      expect(serialized).toContain('lastName');
      expect(serialized).toContain('email');
    });

    it('should ignore surrounding and repeated whitespace', async () => {
      await listUsers(mockAdminDb, { search: '   ana    ' });

      const serialized = whereOf(mockAdminDb.user.findMany);
      expect(serialized).toContain('"contains":"ana"');
      expect(serialized).not.toContain('"contains":""');
    });

    it('should not add a search clause for a blank search', async () => {
      await listUsers(mockAdminDb, { search: '   ' });

      expect(JSON.stringify(mockAdminDb.user.findMany.mock.calls[0][0].where ?? {})).not.toContain('contains');
    });

    it('should combine search with the kind filter', async () => {
      await listUsers(mockAdminDb, { search: 'ana', kind: Roles.TRAINER });

      const serialized = whereOf(mockAdminDb.user.findMany);
      expect(serialized).toContain('"contains":"ana"');
      expect(serialized).toContain(`"roles":{"has":"${Roles.TRAINER}"}`);
    });
  });
});

// ─── getUserOverview ──────────────────────────────────────────────────────────

describe('getUserOverview', () => {
  function answerCounts() {
    mockAdminDb.trainerStudent.count.mockImplementation(async ({ where }) => {
      if (where.studentId) return 4;
      return where.activeOnPlan === true ? 6 : 9;
    });
    mockAdminDb.trainingProtocol.count.mockImplementation(async ({ where }) => {
      return JSON.stringify(where).includes('assigneeId') ? 5 : 11;
    });
    mockAdminDb.trainingTemplate.count.mockResolvedValue(12);
    mockAdminDb.exerciseTemplate.count.mockResolvedValue(13);
    mockAdminDb.challenge.count.mockResolvedValue(2);
    mockAdminDb.workoutSession.count.mockResolvedValue(21);
  }

  it('should throw a 404 AppError admin.userNotFound for an unknown user', async () => {
    mockAdminDb.user.findUnique.mockResolvedValue(null);

    const error = await getUserOverview(mockAdminDb, { userId: USER_ID }).catch((e) => e);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ httpStatus: NOT_FOUND_STATUS, ...USER_NOT_FOUND });
  });

  it('should return trainer null for a user without a trainer profile', async () => {
    mockAdminDb.trainer.findUnique.mockResolvedValue(null);

    const result = await getUserOverview(mockAdminDb, { userId: USER_ID });

    expect(result.trainer).toBeNull();
  });

  it('should return the trainer id, createdAt and planTier for a trainer', async () => {
    mockAdminDb.trainer.findUnique.mockResolvedValue({
      id: TRAINER_ID,
      createdAt: CREATED_AT,
      platformSubscription: { tier: 'PRO' },
    });

    const result = await getUserOverview(mockAdminDb, { userId: USER_ID });

    expect(result.trainer).toEqual({ id: TRAINER_ID, createdAt: CREATED_AT, planTier: 'PRO' });
  });

  it('should return the nine documented counts', async () => {
    answerCounts();
    mockAdminDb.trainer.findUnique.mockResolvedValue({
      id: TRAINER_ID,
      createdAt: CREATED_AT,
      platformSubscription: { tier: 'FREE' },
    });

    const result = await getUserOverview(mockAdminDb, { userId: USER_ID });

    expect(result.counts).toEqual({
      students: 9,
      activeStudents: 6,
      protocolsCreated: 11,
      trainingTemplates: 12,
      exerciseTemplates: 13,
      challenges: 2,
      trainers: 4,
      protocolsAssigned: 5,
      workoutSessions: 21,
    });
  });

  it('should return zero counts for a user without a trainer profile', async () => {
    mockAdminDb.trainer.findUnique.mockResolvedValue(null);

    const result = await getUserOverview(mockAdminDb, { userId: USER_ID });

    expect(result.counts).toMatchObject({
      students: 0,
      activeStudents: 0,
      protocolsCreated: 0,
      trainingTemplates: 0,
      exerciseTemplates: 0,
      challenges: 0,
    });
  });

  it('should expose the user profile and a lastWorkoutAt key', async () => {
    const result = await getUserOverview(mockAdminDb, { userId: USER_ID });

    expect(result).toHaveProperty('lastWorkoutAt');
    expect(result.user).toMatchObject({ id: USER_ID, email: 'ana@example.com' });
  });

  it('should use select and never include on every query', async () => {
    await getUserOverview(mockAdminDb, { userId: USER_ID });

    expectSelectOnly(mockAdminDb.user.findUnique);
  });
});

// ─── listUserStudents ─────────────────────────────────────────────────────────

describe('listUserStudents', () => {
  it('should return an empty paginated list for a non-trainer', async () => {
    mockAdminDb.trainer.findUnique.mockResolvedValue(null);

    const result = await listUserStudents(mockAdminDb, { userId: USER_ID, page: 1, pageSize: 20 });

    expect(result).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
  });

  it('should map linked students to the documented item shape', async () => {
    const lastWorkoutAt = new Date('2026-04-01T08:00:00.000Z');
    mockAdminDb.trainerStudent.findMany.mockResolvedValue([
      {
        studentId: 'student-1',
        activeOnPlan: true,
        lastWorkoutAt,
        createdAt: CREATED_AT,
        student: { firstName: 'Bia', lastName: 'Souza', email: 'bia@example.com', status: 'active' },
      },
    ]);
    mockAdminDb.trainerStudent.count.mockResolvedValue(1);

    const result = await listUserStudents(mockAdminDb, { userId: USER_ID, page: 1, pageSize: 20 });

    expect(result.items[0]).toEqual({
      studentId: 'student-1',
      firstName: 'Bia',
      lastName: 'Souza',
      email: 'bia@example.com',
      status: 'active',
      activeOnPlan: true,
      lastWorkoutAt,
      linkedAt: CREATED_AT,
    });
  });

  it('should paginate with skip, take and a total', async () => {
    mockAdminDb.trainerStudent.count.mockResolvedValue(55);

    const result = await listUserStudents(mockAdminDb, { userId: USER_ID, page: 2, pageSize: 25 });

    expect(result).toMatchObject({ total: 55, page: 2, pageSize: 25 });
    expect(mockAdminDb.trainerStudent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 25, take: 25 }),
    );
  });

  it('should order deterministically with an id tiebreaker', async () => {
    await listUserStudents(mockAdminDb, { userId: USER_ID, page: 1, pageSize: 20 });

    expect(JSON.stringify(mockAdminDb.trainerStudent.findMany.mock.calls[0][0].orderBy)).toContain('"id":"asc"');
  });

  it('should use select and never include', async () => {
    await listUserStudents(mockAdminDb, { userId: USER_ID, page: 1, pageSize: 20 });

    expectSelectOnly(mockAdminDb.trainerStudent.findMany);
  });
});

// ─── listUserTrainers ─────────────────────────────────────────────────────────

describe('listUserTrainers', () => {
  it('should map linked trainers to the documented item shape', async () => {
    mockAdminDb.trainerStudent.findMany.mockResolvedValue([
      {
        trainerId: TRAINER_ID,
        createdAt: CREATED_AT,
        trainer: {
          userId: 'trainer-user-1',
          user: { firstName: 'Caio', lastName: 'Reis', email: 'caio@example.com', status: 'active' },
        },
      },
    ]);
    mockAdminDb.trainerStudent.count.mockResolvedValue(1);

    const result = await listUserTrainers(mockAdminDb, { userId: USER_ID, page: 1, pageSize: 20 });

    expect(result.items[0]).toEqual({
      trainerId: TRAINER_ID,
      userId: 'trainer-user-1',
      firstName: 'Caio',
      lastName: 'Reis',
      email: 'caio@example.com',
      status: 'active',
      linkedAt: CREATED_AT,
    });
  });

  it('should return the paginated envelope', async () => {
    mockAdminDb.trainerStudent.count.mockResolvedValue(3);

    const result = await listUserTrainers(mockAdminDb, { userId: USER_ID, page: 2, pageSize: 2 });

    expect(result).toMatchObject({ total: 3, page: 2, pageSize: 2 });
  });

  it('should filter links by the student user id', async () => {
    await listUserTrainers(mockAdminDb, { userId: USER_ID, page: 1, pageSize: 20 });

    expect(whereOf(mockAdminDb.trainerStudent.findMany)).toContain(USER_ID);
  });

  it('should use select and never include', async () => {
    await listUserTrainers(mockAdminDb, { userId: USER_ID, page: 1, pageSize: 20 });

    expectSelectOnly(mockAdminDb.trainerStudent.findMany);
  });
});

// ─── listUserProtocols ────────────────────────────────────────────────────────

describe('listUserProtocols', () => {
  function makeProtocolRow(overrides = {}) {
    return {
      id: PROTOCOL_ID,
      name: 'Hipertrofia A',
      startDate: new Date('2026-03-05T00:00:00.000Z'),
      expirationDate: new Date('2026-04-30T00:00:00.000Z'),
      createdAt: CREATED_AT,
      deletedAt: null,
      trainer: { user: { firstName: 'Caio', lastName: 'Reis' } },
      assignee: { firstName: 'Bia', lastName: 'Souza' },
      _count: { trainings: 3 },
      ...overrides,
    };
  }

  it('should filter by trainer ownership when as is trainer', async () => {
    await listUserProtocols(mockAdminDb, { userId: USER_ID, as: 'trainer', page: 1, pageSize: 20 });

    expect(whereOf(mockAdminDb.trainingProtocol.findMany)).toContain('trainer');
  });

  it('should filter by assigneeId when as is student', async () => {
    await listUserProtocols(mockAdminDb, { userId: USER_ID, as: 'student', page: 1, pageSize: 20 });

    expect(whereOf(mockAdminDb.trainingProtocol.findMany)).toContain(`"assigneeId":"${USER_ID}"`);
  });

  it('should format startDate and endDate as YYYY-MM-DD', async () => {
    mockAdminDb.trainingProtocol.findMany.mockResolvedValue([makeProtocolRow()]);

    const { items } = await listUserProtocols(mockAdminDb, { userId: USER_ID, as: 'trainer', page: 1, pageSize: 20 });

    expect(items[0]).toMatchObject({ startDate: '2026-03-05', endDate: '2026-04-30' });
  });

  it('should return a null endDate when the protocol has no expiration', async () => {
    mockAdminDb.trainingProtocol.findMany.mockResolvedValue([makeProtocolRow({ expirationDate: null })]);

    const { items } = await listUserProtocols(mockAdminDb, { userId: USER_ID, as: 'trainer', page: 1, pageSize: 20 });

    expect(items[0].endDate).toBeNull();
  });

  it('should map the documented item fields with trainer and assignee names', async () => {
    mockAdminDb.trainingProtocol.findMany.mockResolvedValue([makeProtocolRow()]);

    const { items } = await listUserProtocols(mockAdminDb, { userId: USER_ID, as: 'trainer', page: 1, pageSize: 20 });

    expect(items[0]).toEqual({
      id: PROTOCOL_ID,
      name: 'Hipertrofia A',
      trainerName: 'Caio Reis',
      assigneeName: 'Bia Souza',
      startDate: '2026-03-05',
      endDate: '2026-04-30',
      trainingsCount: 3,
      createdAt: CREATED_AT,
      deletedAt: null,
    });
  });

  it('should return the paginated envelope with skip and take', async () => {
    mockAdminDb.trainingProtocol.count.mockResolvedValue(30);

    const result = await listUserProtocols(mockAdminDb, { userId: USER_ID, as: 'trainer', page: 2, pageSize: 10 });

    expect(result).toMatchObject({ total: 30, page: 2, pageSize: 10 });
    expect(mockAdminDb.trainingProtocol.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 10, take: 10 }),
    );
  });

  it('should order by createdAt desc then id asc', async () => {
    await listUserProtocols(mockAdminDb, { userId: USER_ID, as: 'trainer', page: 1, pageSize: 20 });

    expect(mockAdminDb.trainingProtocol.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] }),
    );
  });

  it('should use select and never include', async () => {
    await listUserProtocols(mockAdminDb, { userId: USER_ID, as: 'trainer', page: 1, pageSize: 20 });

    expectSelectOnly(mockAdminDb.trainingProtocol.findMany);
  });
});

// ─── getProtocolDetail ────────────────────────────────────────────────────────

describe('getProtocolDetail', () => {
  function makeProtocolDetailRow() {
    return {
      id: PROTOCOL_ID,
      name: 'Hipertrofia A',
      description: 'Bloco de 8 semanas',
      status: 'active',
      startDate: new Date('2026-03-05T00:00:00.000Z'),
      expirationDate: new Date('2026-04-30T00:00:00.000Z'),
      createdAt: CREATED_AT,
      deletedAt: null,
      trainer: { user: { firstName: 'Caio', lastName: 'Reis' } },
      assignee: { firstName: 'Bia', lastName: 'Souza' },
      trainings: [
        {
          id: 'training-1',
          name: 'Treino A',
          order: 0,
          exercises: [
            {
              id: 'exercise-1',
              name: 'Supino reto',
              order: 0,
              sets: 4,
              repetitions: [10, 10, 8, 8],
              suggestedLoad: 60,
              restInterval: 90,
              notes: 'Controlar a descida',
            },
          ],
        },
      ],
    };
  }

  it('should throw a 404 AppError admin.protocolNotFound for an unknown protocol', async () => {
    mockAdminDb.trainingProtocol.findUnique.mockResolvedValue(null);

    const error = await getProtocolDetail(mockAdminDb, { protocolId: PROTOCOL_ID }).catch((e) => e);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ httpStatus: NOT_FOUND_STATUS, ...PROTOCOL_NOT_FOUND });
  });

  it('should return the header with date-only fields as YYYY-MM-DD', async () => {
    mockAdminDb.trainingProtocol.findUnique.mockResolvedValue(makeProtocolDetailRow());

    const result = await getProtocolDetail(mockAdminDb, { protocolId: PROTOCOL_ID });

    expect(result).toMatchObject({
      id: PROTOCOL_ID,
      name: 'Hipertrofia A',
      startDate: '2026-03-05',
      endDate: '2026-04-30',
    });
  });

  it('should return trainings each with their exercises as stored', async () => {
    mockAdminDb.trainingProtocol.findUnique.mockResolvedValue(makeProtocolDetailRow());

    const result = await getProtocolDetail(mockAdminDb, { protocolId: PROTOCOL_ID });

    expect(result.trainings[0].exercises[0]).toMatchObject({
      name: 'Supino reto',
      sets: 4,
      repetitions: [10, 10, 8, 8],
      suggestedLoad: 60,
      restInterval: 90,
      notes: 'Controlar a descida',
    });
  });

  it('should request trainings and exercises ordered ascending by order', async () => {
    mockAdminDb.trainingProtocol.findUnique.mockResolvedValue(makeProtocolDetailRow());

    await getProtocolDetail(mockAdminDb, { protocolId: PROTOCOL_ID });

    const selectArgs = JSON.stringify(mockAdminDb.trainingProtocol.findUnique.mock.calls[0][0].select);
    expect(selectArgs.match(/"order":"asc"/g)).toHaveLength(2);
  });

  it('should look the protocol up by id with select and no include', async () => {
    mockAdminDb.trainingProtocol.findUnique.mockResolvedValue(makeProtocolDetailRow());

    await getProtocolDetail(mockAdminDb, { protocolId: PROTOCOL_ID });

    expect(mockAdminDb.trainingProtocol.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: PROTOCOL_ID }, select: expect.any(Object) }),
    );
    expectSelectOnly(mockAdminDb.trainingProtocol.findUnique);
  });
});

// ─── listUserTemplates ────────────────────────────────────────────────────────

describe('listUserTemplates', () => {
  it('should list training templates when type is training', async () => {
    mockAdminDb.trainingTemplate.findMany.mockResolvedValue([
      { id: 'tt-1', name: 'Peito', createdAt: CREATED_AT, deletedAt: null },
    ]);
    mockAdminDb.trainingTemplate.count.mockResolvedValue(1);

    const result = await listUserTemplates(mockAdminDb, { userId: USER_ID, type: 'training', page: 1, pageSize: 20 });

    expect(result).toEqual({
      items: [{ id: 'tt-1', name: 'Peito', createdAt: CREATED_AT, deletedAt: null }],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    expect(mockAdminDb.exerciseTemplate.findMany).not.toHaveBeenCalled();
  });

  it('should list exercise templates when type is exercise', async () => {
    mockAdminDb.exerciseTemplate.findMany.mockResolvedValue([
      { id: 'et-1', name: 'Supino', createdAt: CREATED_AT, deletedAt: null },
    ]);
    mockAdminDb.exerciseTemplate.count.mockResolvedValue(1);

    const result = await listUserTemplates(mockAdminDb, { userId: USER_ID, type: 'exercise', page: 1, pageSize: 20 });

    expect(result.items[0]).toEqual({ id: 'et-1', name: 'Supino', createdAt: CREATED_AT, deletedAt: null });
    expect(mockAdminDb.trainingTemplate.findMany).not.toHaveBeenCalled();
  });

  it('should return an empty list for a non-trainer', async () => {
    mockAdminDb.trainer.findUnique.mockResolvedValue(null);

    const result = await listUserTemplates(mockAdminDb, { userId: USER_ID, type: 'training', page: 1, pageSize: 20 });

    expect(result).toMatchObject({ items: [], total: 0 });
  });

  it('should include soft-deleted templates flagged with deletedAt', async () => {
    const deletedAt = new Date('2026-03-01T00:00:00.000Z');
    mockAdminDb.trainingTemplate.findMany.mockResolvedValue([
      { id: 'tt-2', name: 'Costas', createdAt: CREATED_AT, deletedAt },
    ]);

    const { items } = await listUserTemplates(mockAdminDb, { userId: USER_ID, type: 'training', page: 1, pageSize: 20 });

    expect(items[0].deletedAt).toEqual(deletedAt);
  });

  it('should paginate with skip and take', async () => {
    await listUserTemplates(mockAdminDb, { userId: USER_ID, type: 'training', page: 4, pageSize: 5 });

    expect(mockAdminDb.trainingTemplate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 15, take: 5 }),
    );
  });

  it('should use select and never include', async () => {
    await listUserTemplates(mockAdminDb, { userId: USER_ID, type: 'training', page: 1, pageSize: 20 });

    expectSelectOnly(mockAdminDb.trainingTemplate.findMany);
  });
});

// ─── listUserSessions ─────────────────────────────────────────────────────────

describe('listUserSessions', () => {
  const STARTED_AT = new Date('2026-04-02T09:00:00.000Z');
  const FINISHED_AT = new Date('2026-04-02T09:50:00.000Z');

  it('should map sessions to the documented item shape', async () => {
    mockAdminDb.workoutSession.findMany.mockResolvedValue([
      {
        id: 'session-1',
        startedAt: STARTED_AT,
        finishedAt: FINISHED_AT,
        durationSeconds: 3000,
        training: { name: 'Treino A' },
      },
    ]);
    mockAdminDb.workoutSession.count.mockResolvedValue(1);

    const result = await listUserSessions(mockAdminDb, { userId: USER_ID, page: 1, pageSize: 20 });

    expect(result.items[0]).toEqual({
      id: 'session-1',
      trainingName: 'Treino A',
      startedAt: STARTED_AT,
      finishedAt: FINISHED_AT,
      durationSec: 3000,
    });
  });

  it('should keep an in-progress session with null finishedAt and durationSec', async () => {
    mockAdminDb.workoutSession.findMany.mockResolvedValue([
      { id: 'session-2', startedAt: STARTED_AT, finishedAt: null, durationSeconds: null, training: { name: 'Treino B' } },
    ]);

    const { items } = await listUserSessions(mockAdminDb, { userId: USER_ID, page: 1, pageSize: 20 });

    expect(items[0]).toMatchObject({ finishedAt: null, durationSec: null });
  });

  it('should order by startedAt desc', async () => {
    await listUserSessions(mockAdminDb, { userId: USER_ID, page: 1, pageSize: 20 });

    expect(JSON.stringify(mockAdminDb.workoutSession.findMany.mock.calls[0][0].orderBy)).toContain('"startedAt":"desc"');
  });

  it('should return the paginated envelope with skip and take', async () => {
    mockAdminDb.workoutSession.count.mockResolvedValue(70);

    const result = await listUserSessions(mockAdminDb, { userId: USER_ID, page: 3, pageSize: 20 });

    expect(result).toMatchObject({ total: 70, page: 3, pageSize: 20 });
    expect(mockAdminDb.workoutSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 40, take: 20 }),
    );
  });

  it('should filter by the user id', async () => {
    await listUserSessions(mockAdminDb, { userId: USER_ID, page: 1, pageSize: 20 });

    expect(whereOf(mockAdminDb.workoutSession.findMany)).toContain(USER_ID);
  });

  it('should use select and never include', async () => {
    await listUserSessions(mockAdminDb, { userId: USER_ID, page: 1, pageSize: 20 });

    expectSelectOnly(mockAdminDb.workoutSession.findMany);
  });
});

// ─── Statement timeout mapping ────────────────────────────────────────────────

describe('statement timeout mapping', () => {
  const calls = {
    listUsers: () => listUsers(mockAdminDb, { page: 1, pageSize: 20 }),
    getUserOverview: () => getUserOverview(mockAdminDb, { userId: USER_ID }),
    listUserStudents: () => listUserStudents(mockAdminDb, { userId: USER_ID, page: 1, pageSize: 20 }),
    listUserTrainers: () => listUserTrainers(mockAdminDb, { userId: USER_ID, page: 1, pageSize: 20 }),
    listUserProtocols: () => listUserProtocols(mockAdminDb, { userId: USER_ID, as: 'trainer', page: 1, pageSize: 20 }),
    getProtocolDetail: () => getProtocolDetail(mockAdminDb, { protocolId: PROTOCOL_ID }),
    listUserTemplates: () => listUserTemplates(mockAdminDb, { userId: USER_ID, type: 'training', page: 1, pageSize: 20 }),
    listUserSessions: () => listUserSessions(mockAdminDb, { userId: USER_ID, page: 1, pageSize: 20 }),
  };

  describe.each(Object.entries(calls))('%s', (_name, call) => {
    it('should map a raw pg 57014 error to a 503 AppError admin.queryTimeout', async () => {
      rejectAllQueries(makePgTimeoutError());

      const error = await call().catch((e) => e);

      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ httpStatus: UNAVAILABLE_STATUS, messageCode: QUERY_TIMEOUT_MESSAGE_CODE });
    });
  });

  it('should map a Prisma-wrapped driver adapter 57014 error to admin.queryTimeout', async () => {
    rejectAllQueries(makePrismaWrappedTimeoutError());

    const error = await listUsers(mockAdminDb, {}).catch((e) => e);

    expect(error).toMatchObject({ httpStatus: UNAVAILABLE_STATUS, messageCode: QUERY_TIMEOUT_MESSAGE_CODE });
  });

  it('should map an error whose cause is a 57014 error to admin.queryTimeout', async () => {
    rejectAllQueries(makeCausedTimeoutError());

    const error = await listUsers(mockAdminDb, {}).catch((e) => e);

    expect(error).toMatchObject({ httpStatus: UNAVAILABLE_STATUS, messageCode: QUERY_TIMEOUT_MESSAGE_CODE });
  });

  it('should expose the unified error contract without internals', async () => {
    rejectAllQueries(makePgTimeoutError());

    const error = await listUsers(mockAdminDb, {}).catch((e) => e);

    expect(error).toMatchObject({
      error: expect.any(String),
      messageCode: QUERY_TIMEOUT_MESSAGE_CODE,
      message: expect.any(String),
    });
    expect(error.message).not.toContain('statement timeout');
  });

  it('should rethrow non-timeout errors unchanged', async () => {
    const boom = new Error('connection reset');
    rejectAllQueries(boom);

    const error = await listUsers(mockAdminDb, {}).catch((e) => e);

    expect(error).toBe(boom);
  });
});
