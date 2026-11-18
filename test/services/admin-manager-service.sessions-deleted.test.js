import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listUserSessions } from '../../src/services/admin-manager-service.js';
import { listUserSessionsSchema } from '../../api/schemas/admin-manager-route.schema.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PAGE_ARGS = { userId: USER_ID, page: 1, pageSize: 20 };
const OK_STATUS = 200;
const STARTED_AT = new Date('2026-04-02T09:00:00.000Z');
const FINISHED_AT = new Date('2026-04-02T09:50:00.000Z');
const DELETED_AT = new Date('2026-04-03T12:00:00.000Z');
const DURATION_SECONDS = 3000;

const mockAdminDb = {
  workoutSession: { findMany: vi.fn(), count: vi.fn() },
};

// Builds a workout session row as the list query selects it.
function makeSessionRow(overrides = {}) {
  return {
    id: 'session-1',
    startedAt: STARTED_AT,
    finishedAt: FINISHED_AT,
    durationSeconds: DURATION_SECONDS,
    deletedAt: null,
    training: { name: 'Treino A' },
    ...overrides,
  };
}

// Returns the item schema of the sessions list 200 response.
function sessionItemSchema() {
  return listUserSessionsSchema.response[OK_STATUS].properties.items.items;
}

describe('listUserSessions — soft-deleted sessions', () => {
  beforeEach(() => {
    mockAdminDb.workoutSession.findMany.mockResolvedValue([]);
    mockAdminDb.workoutSession.count.mockResolvedValue(0);
  });

  it('should select deletedAt in the list query', async () => {
    await listUserSessions(mockAdminDb, PAGE_ARGS);

    expect(mockAdminDb.workoutSession.findMany.mock.calls[0][0].select).toMatchObject({ deletedAt: true });
  });

  it('should map deletedAt to the date for a soft-deleted session', async () => {
    mockAdminDb.workoutSession.findMany.mockResolvedValue([makeSessionRow({ deletedAt: DELETED_AT })]);
    mockAdminDb.workoutSession.count.mockResolvedValue(1);

    const { items } = await listUserSessions(mockAdminDb, PAGE_ARGS);

    expect(items[0]).toHaveProperty('deletedAt', DELETED_AT);
  });

  it('should map deletedAt to null for a live session', async () => {
    mockAdminDb.workoutSession.findMany.mockResolvedValue([makeSessionRow()]);
    mockAdminDb.workoutSession.count.mockResolvedValue(1);

    const { items } = await listUserSessions(mockAdminDb, PAGE_ARGS);

    expect(items[0]).toHaveProperty('deletedAt', null);
  });

  it('should keep the existing item fields alongside deletedAt', async () => {
    mockAdminDb.workoutSession.findMany.mockResolvedValue([makeSessionRow({ deletedAt: DELETED_AT })]);
    mockAdminDb.workoutSession.count.mockResolvedValue(1);

    const { items } = await listUserSessions(mockAdminDb, PAGE_ARGS);

    expect(items[0]).toEqual({
      id: 'session-1',
      trainingName: 'Treino A',
      startedAt: STARTED_AT,
      finishedAt: FINISHED_AT,
      durationSec: DURATION_SECONDS,
      deletedAt: DELETED_AT,
    });
  });
});

describe('listUserSessionsSchema — deletedAt', () => {
  it('should declare deletedAt as a nullable date-time on each item so the serializer keeps it', () => {
    expect(sessionItemSchema().properties.deletedAt).toMatchObject({
      type: 'string',
      format: 'date-time',
      nullable: true,
    });
  });
});
