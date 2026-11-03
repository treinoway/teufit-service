import { describe, it, expect, vi } from 'vitest';
import { getProtocolDetail } from '../../src/services/admin-manager-service.js';

const PROTOCOL_ID = '33333333-3333-4333-8333-333333333333';
const CREATED_AT = new Date('2026-02-01T10:00:00.000Z');
const DELETED_AT = new Date('2026-03-01T10:00:00.000Z');
const NOT_DELETED_FILTER = { deletedAt: null };
const PRINCIPAL_EXERCISE_FILTER = { deletedAt: null, substituteForExerciseId: null };

const mockAdminDb = {
  trainingProtocol: { findUnique: vi.fn() },
};

// Builds a protocol detail row, optionally overriding fields such as deletedAt.
function makeProtocolRow(overrides = {}) {
  return {
    id: PROTOCOL_ID,
    name: 'Hipertrofia A',
    description: null,
    status: 'active',
    startDate: new Date('2026-03-05T00:00:00.000Z'),
    expirationDate: new Date('2026-04-30T00:00:00.000Z'),
    createdAt: CREATED_AT,
    deletedAt: null,
    trainer: { user: { firstName: 'Caio', lastName: 'Reis' } },
    assignee: { firstName: 'Bia', lastName: 'Souza' },
    trainings: [],
    ...overrides,
  };
}

describe('getProtocolDetail soft-delete handling', () => {
  it('should filter out soft-deleted trainings in the select', async () => {
    mockAdminDb.trainingProtocol.findUnique.mockResolvedValue(makeProtocolRow());

    await getProtocolDetail(mockAdminDb, { protocolId: PROTOCOL_ID });

    const { select } = mockAdminDb.trainingProtocol.findUnique.mock.calls[0][0];
    expect(select.trainings.where).toEqual(NOT_DELETED_FILTER);
  });

  it('should filter out soft-deleted exercises in the nested select', async () => {
    mockAdminDb.trainingProtocol.findUnique.mockResolvedValue(makeProtocolRow());

    await getProtocolDetail(mockAdminDb, { protocolId: PROTOCOL_ID });

    const { select } = mockAdminDb.trainingProtocol.findUnique.mock.calls[0][0];
    expect(select.trainings.select.exercises.where).toEqual(PRINCIPAL_EXERCISE_FILTER);
  });

  it('should not filter the protocol itself by deletedAt', async () => {
    mockAdminDb.trainingProtocol.findUnique.mockResolvedValue(makeProtocolRow());

    await getProtocolDetail(mockAdminDb, { protocolId: PROTOCOL_ID });

    const { where } = mockAdminDb.trainingProtocol.findUnique.mock.calls[0][0];
    expect(where).toEqual({ id: PROTOCOL_ID });
  });

  it('should still return a soft-deleted protocol with its deletedAt', async () => {
    mockAdminDb.trainingProtocol.findUnique.mockResolvedValue(makeProtocolRow({ deletedAt: DELETED_AT }));

    const result = await getProtocolDetail(mockAdminDb, { protocolId: PROTOCOL_ID });

    expect(result).toMatchObject({ id: PROTOCOL_ID, deletedAt: DELETED_AT });
  });
});
