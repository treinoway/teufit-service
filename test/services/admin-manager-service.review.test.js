import { describe, it, expect, vi } from 'vitest';
import { getProtocolDetail, listUserProtocols } from '../../src/services/admin-manager-service.js';
import { AdminManagerMessageCode, ADMIN_MANAGER_ERROR_UNAVAILABLE } from '../../src/constants/admin-manager.js';
import { AppError } from '../../src/errors/app-error.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PROTOCOL_ID = '33333333-3333-4333-8333-333333333333';
const UNAVAILABLE_STATUS = 503;
const PRISMA_POOL_TIMEOUT_CODE = 'P2024';
const POOL_TIMEOUT_MESSAGE = 'timeout exceeded when trying to connect';
const LIVE_ONLY_FILTER = { deletedAt: null };
const PRINCIPAL_ONLY_FILTER = { deletedAt: null, substituteForExerciseId: null };

const mockAdminDb = {
  trainingProtocol: { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn() },
};

// Builds an exercise row with the raw stored prescription fields.
function makeExerciseRow(overrides = {}) {
  return {
    id: 'ex-1',
    name: 'Supino',
    order: 0,
    sets: 3,
    repetitions: null,
    prescriptionMode: null,
    duration: null,
    hasLoad: false,
    suggestedLoad: null,
    restInterval: null,
    notes: null,
    ...overrides,
  };
}

// Builds a protocol detail row holding one training with the given exercises.
function makeProtocolRow(exercises) {
  return {
    id: PROTOCOL_ID,
    name: 'Hipertrofia A',
    description: null,
    status: 'active',
    startDate: new Date('2026-03-05T00:00:00.000Z'),
    expirationDate: new Date('2026-04-30T00:00:00.000Z'),
    createdAt: new Date('2026-02-01T10:00:00.000Z'),
    deletedAt: null,
    trainer: { user: { firstName: 'Caio', lastName: 'Reis' } },
    assignee: { firstName: 'Bia', lastName: 'Souza' },
    trainings: [{ id: 't-1', name: 'Treino A', order: 0, exercises }],
  };
}

// Resolves the first exercise returned by getProtocolDetail for the given exercise row.
async function detailFirstExercise(exerciseRow) {
  mockAdminDb.trainingProtocol.findUnique.mockResolvedValue(makeProtocolRow([exerciseRow]));
  const result = await getProtocolDetail(mockAdminDb, { protocolId: PROTOCOL_ID });
  return result.trainings[0].exercises[0];
}

// Calls listUserProtocols with an empty result set.
async function callListUserProtocols() {
  mockAdminDb.trainingProtocol.findMany.mockResolvedValue([]);
  mockAdminDb.trainingProtocol.count.mockResolvedValue(0);
  return listUserProtocols(mockAdminDb, { userId: USER_ID });
}

describe('getProtocolDetail exercise prescription', () => {
  it('should request prescriptionMode and duration in the exercise select', async () => {
    mockAdminDb.trainingProtocol.findUnique.mockResolvedValue(makeProtocolRow([]));

    await getProtocolDetail(mockAdminDb, { protocolId: PROTOCOL_ID });

    const { select } = mockAdminDb.trainingProtocol.findUnique.mock.calls[0][0].select.trainings.select.exercises;
    expect(select).toMatchObject({ prescriptionMode: true, duration: true });
  });

  it('should exclude soft-deleted exercises and substitutes in the where', async () => {
    mockAdminDb.trainingProtocol.findUnique.mockResolvedValue(makeProtocolRow([]));

    await getProtocolDetail(mockAdminDb, { protocolId: PROTOCOL_ID });

    const { where } = mockAdminDb.trainingProtocol.findUnique.mock.calls[0][0].select.trainings.select.exercises;
    expect(where).toEqual(PRINCIPAL_ONLY_FILTER);
  });

  it('should return prescriptionMode and duration per exercise', async () => {
    const exercise = await detailFirstExercise(makeExerciseRow({ prescriptionMode: 'duration', duration: 45 }));

    expect(exercise).toMatchObject({ prescriptionMode: 'duration', duration: 45 });
  });

  it('should return a {min,max} repetitions object raw', async () => {
    const exercise = await detailFirstExercise(makeExerciseRow({ repetitions: { min: 8, max: 12 } }));

    expect(exercise.repetitions).toEqual({ min: 8, max: 12 });
  });

  it('should return a numeric repetitions value raw', async () => {
    const exercise = await detailFirstExercise(makeExerciseRow({ repetitions: 10 }));

    expect(exercise.repetitions).toBe(10);
  });

  it('should pass an array of repetitions through untouched', async () => {
    const exercise = await detailFirstExercise(makeExerciseRow({ repetitions: [12, 10, 8] }));

    expect(exercise.repetitions).toEqual([12, 10, 8]);
  });
});

describe('listUserProtocols trainings count', () => {
  it('should count only non-deleted trainings in the _count select', async () => {
    await callListUserProtocols();

    const { select } = mockAdminDb.trainingProtocol.findMany.mock.calls[0][0];
    expect(select._count.select.trainings).toEqual({ where: LIVE_ONLY_FILTER });
  });
});

// Asserts the promise rejects with the 503 queryTimeout AppError.
async function expectQueryTimeout(promise) {
  const error = await promise.then(
    () => null,
    (caught) => caught,
  );
  expect(error).toBeInstanceOf(AppError);
  expect(error).toMatchObject({
    httpStatus: UNAVAILABLE_STATUS,
    error: ADMIN_MANAGER_ERROR_UNAVAILABLE,
    messageCode: AdminManagerMessageCode.QUERY_TIMEOUT,
  });
}


describe('query timeout mapping', () => {
  it('should map a pool connection timeout message to 503 admin.queryTimeout', async () => {
    mockAdminDb.trainingProtocol.findUnique.mockRejectedValue(new Error(POOL_TIMEOUT_MESSAGE));

    await expectQueryTimeout(getProtocolDetail(mockAdminDb, { protocolId: PROTOCOL_ID }));
  });

  it('should map a Prisma P2024 error to 503 admin.queryTimeout', async () => {
    mockAdminDb.trainingProtocol.findUnique.mockRejectedValue(Object.assign(new Error('pool'), { code: PRISMA_POOL_TIMEOUT_CODE }));

    await expectQueryTimeout(getProtocolDetail(mockAdminDb, { protocolId: PROTOCOL_ID }));
  });

  it('should map a pool timeout nested in cause to 503 admin.queryTimeout', async () => {
    const wrapped = new Error('query failed', { cause: new Error(POOL_TIMEOUT_MESSAGE) });
    mockAdminDb.trainingProtocol.findUnique.mockRejectedValue(wrapped);

    await expectQueryTimeout(getProtocolDetail(mockAdminDb, { protocolId: PROTOCOL_ID }));
  });

  it('should map a pool timeout in listUserProtocols too', async () => {
    mockAdminDb.trainingProtocol.findMany.mockRejectedValue(new Error(POOL_TIMEOUT_MESSAGE));
    mockAdminDb.trainingProtocol.count.mockResolvedValue(0);

    await expectQueryTimeout(listUserProtocols(mockAdminDb, { userId: USER_ID }));
  });

  it('should rethrow unrelated errors unchanged', async () => {
    const unrelated = new Error('connection refused');
    mockAdminDb.trainingProtocol.findUnique.mockRejectedValue(unrelated);

    await expect(getProtocolDetail(mockAdminDb, { protocolId: PROTOCOL_ID })).rejects.toBe(unrelated);
  });
});
