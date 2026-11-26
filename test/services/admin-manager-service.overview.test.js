import { describe, it, expect } from 'vitest';
import { getOverview, getPending } from '../../src/services/admin-manager-service.js';
import {
  AdminManagerMessageCode,
  ADMIN_MANAGER_ERROR_UNAVAILABLE,
  OVERVIEW_PERIODS,
  OVERVIEW_DEFAULT_PERIOD,
  POSTGRES_STATEMENT_TIMEOUT_CODE,
} from '../../src/constants/admin-manager.js';
import { getOverviewSchema, getPendingSchema } from '../../api/schemas/admin-manager-route.schema.js';
import { AppError } from '../../src/errors/app-error.js';

const UNAVAILABLE_STATUS = 503;
const STATEMENT_TIMEOUT_MESSAGE = 'canceling statement due to statement timeout';
const NOT_PROMISE_KEYS = new Set(['then', 'catch', 'finally']);

// Builds a raw pg statement-timeout error.
function rawStatementTimeout() {
  return Object.assign(new Error(STATEMENT_TIMEOUT_MESSAGE), { code: POSTGRES_STATEMENT_TIMEOUT_CODE });
}

// Builds a Prisma driver-adapter error wrapping a statement timeout.
function wrappedStatementTimeout() {
  return Object.assign(new Error('Prisma query failed'), {
    code: 'P2010',
    meta: { driverAdapterError: { cause: { originalCode: POSTGRES_STATEMENT_TIMEOUT_CODE } } },
  });
}

// Builds a function that rejects with the given error whatever it is called with.
function rejectingCall(makeError) {
  return () => Promise.reject(makeError());
}

// Builds a model delegate whose every query method rejects with the error.
function rejectingDelegate(makeError) {
  return new Proxy({}, {
    get: (_target, key) => (NOT_PROMISE_KEYS.has(key) || typeof key === 'symbol' ? undefined : rejectingCall(makeError)),
  });
}

// Builds an adminDb stand-in where every model method and raw query rejects with the error.
function timingOutAdminDb(makeError) {
  return new Proxy({}, {
    get: (_target, key) => {
      if (NOT_PROMISE_KEYS.has(key) || typeof key === 'symbol') return undefined;
      if (String(key).startsWith('$')) return rejectingCall(makeError);
      return rejectingDelegate(makeError);
    },
  });
}

// Returns what the promise rejects with (null when it resolves).
async function rejectionOf(promise) {
  return promise.then(() => null, (caught) => caught);
}

// Asserts the error is the 503 admin.queryTimeout AppError.
function expectQueryTimeout(error) {
  expect(error).toBeInstanceOf(AppError);
  expect(error).toMatchObject({
    httpStatus: UNAVAILABLE_STATUS,
    error: ADMIN_MANAGER_ERROR_UNAVAILABLE,
    messageCode: AdminManagerMessageCode.QUERY_TIMEOUT,
  });
}

describe('getOverview query timeout', () => {
  it('should map a raw pg 57014 error to 503 admin.queryTimeout', async () => {
    const error = await rejectionOf(getOverview(timingOutAdminDb(rawStatementTimeout), { period: OVERVIEW_PERIODS.DAYS_30 }));

    expectQueryTimeout(error);
  });

  it('should map a Prisma-wrapped 57014 error to 503 admin.queryTimeout', async () => {
    const error = await rejectionOf(getOverview(timingOutAdminDb(wrappedStatementTimeout), { period: OVERVIEW_PERIODS.DAYS_7 }));

    expectQueryTimeout(error);
  });

  it('should rethrow an unrelated error unchanged', async () => {
    const unrelated = new Error('connection refused');

    const error = await rejectionOf(getOverview(timingOutAdminDb(() => unrelated), { period: OVERVIEW_PERIODS.DAYS_90 }));

    expect(error).toBe(unrelated);
  });
});

describe('getPending query timeout', () => {
  it('should map a raw pg 57014 error to 503 admin.queryTimeout', async () => {
    const error = await rejectionOf(getPending(timingOutAdminDb(rawStatementTimeout)));

    expectQueryTimeout(error);
  });

  it('should map a Prisma-wrapped 57014 error to 503 admin.queryTimeout', async () => {
    const error = await rejectionOf(getPending(timingOutAdminDb(wrappedStatementTimeout)));

    expectQueryTimeout(error);
  });

  it('should rethrow an unrelated error unchanged', async () => {
    const unrelated = new Error('connection refused');

    const error = await rejectionOf(getPending(timingOutAdminDb(() => unrelated)));

    expect(error).toBe(unrelated);
  });
});

describe('overview route schema', () => {
  it('should accept only the overview periods', () => {
    expect(getOverviewSchema.querystring.properties.period.enum).toEqual(Object.values(OVERVIEW_PERIODS));
  });

  it('should default the period to 30d', () => {
    expect(getOverviewSchema.querystring.properties.period.default).toBe(OVERVIEW_DEFAULT_PERIOD);
  });

  it('should declare 400, 401, 403 and 503 error responses', () => {
    expect(Object.keys(getOverviewSchema.response)).toEqual(expect.arrayContaining(['200', '400', '401', '403', '503']));
  });
});

describe('pending route schema', () => {
  it('should return exactly pendingInvites and newFeedbacks', () => {
    expect(Object.keys(getPendingSchema.response[200].properties).sort()).toEqual(['newFeedbacks', 'pendingInvites']);
  });

  it('should declare 401, 403 and 503 error responses', () => {
    expect(Object.keys(getPendingSchema.response)).toEqual(expect.arrayContaining(['200', '401', '403', '503']));
  });
});
