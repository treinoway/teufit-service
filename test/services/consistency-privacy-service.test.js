import { describe, expect, it } from 'vitest';
import {
  getPrivacy,
  privacyCountsFor,
  setPrivacy,
} from '../../src/services/consistency-privacy-service.js';
import {
  AppearAs,
  CONSISTENCY_PRIVACY_TERM_VERSION,
  ConsistencyErrorCode,
  ConsistencyMessageCode,
} from '../../src/constants/consistency-ranking.js';

const MONDAY = new Date('2026-11-23T13:00:00.000Z');
const TUESDAY = new Date('2026-11-24T13:00:00.000Z');

// In-memory consistency_privacy_prefs table answering the Prisma calls with stored rows
function privacyTable(initial = []) {
  const rows = new Map(initial.map((row) => [row.studentId, { id: `pref-${row.studentId}`, updatedAt: null, ...row }]));
  return {
    rows,
    consistencyPrivacyPref: {
      findUnique: async ({ where }) => rows.get(where.studentId) ?? null,
      findMany: async ({ where }) => [...rows.values()].filter((row) => where.studentId.in.includes(row.studentId)),
      upsert: async ({ where, create, update }) => {
        const current = rows.get(where.studentId);
        const next = current ? { ...current, ...update, updatedAt: new Date() } : { id: `pref-${where.studentId}`, updatedAt: null, ...create };
        rows.set(where.studentId, next);
        return next;
      },
    },
  };
}

describe('consistency-privacy-service', () => {
  it('APP-21 stores the choice, the date and the term version', async () => {
    const prisma = privacyTable();

    const before = await getPrivacy(prisma, 'camila');
    const saved = await setPrivacy(prisma, 'camila', AppearAs.ANONYMOUS, CONSISTENCY_PRIVACY_TERM_VERSION, MONDAY);
    const after = await getPrivacy(prisma, 'camila');

    expect(before).toEqual({ appearAs: AppearAs.PENDING, termVersion: CONSISTENCY_PRIVACY_TERM_VERSION, acceptedAt: null });
    expect(saved).toEqual({ appearAs: AppearAs.ANONYMOUS, termVersion: CONSISTENCY_PRIVACY_TERM_VERSION, acceptedAt: MONDAY });
    expect(prisma.rows.get('camila')).toMatchObject({ appearAs: 'anonymous', termVersion: CONSISTENCY_PRIVACY_TERM_VERSION, acceptedAt: MONDAY });
    expect(after).toEqual({ appearAs: AppearAs.ANONYMOUS, termVersion: CONSISTENCY_PRIVACY_TERM_VERSION, acceptedAt: MONDAY });
  });

  it('APP-21 rejects a choice other than name or anonymous, or an outdated term, without storing it', async () => {
    const prisma = privacyTable();

    for (const [appearAs, termVersion] of [[AppearAs.PENDING, CONSISTENCY_PRIVACY_TERM_VERSION], ['public', CONSISTENCY_PRIVACY_TERM_VERSION], [AppearAs.NAME, '2020-01-v0'], [AppearAs.NAME, undefined]]) {
      await expect(setPrivacy(prisma, 'camila', appearAs, termVersion, MONDAY)).rejects.toMatchObject({
        httpStatus: 400,
        error: ConsistencyErrorCode.PRIVACY_INVALID,
        messageCode: ConsistencyMessageCode.PRIVACY_INVALID,
      });
    }
    expect(prisma.rows.size).toBe(0);
  });

  it('APP-23 replaces the choice and counts it on the next read', async () => {
    const prisma = privacyTable();
    await setPrivacy(prisma, 'camila', AppearAs.NAME, CONSISTENCY_PRIVACY_TERM_VERSION, MONDAY);
    const countsBefore = await privacyCountsFor(prisma, ['camila']);

    await setPrivacy(prisma, 'camila', AppearAs.ANONYMOUS, CONSISTENCY_PRIVACY_TERM_VERSION, TUESDAY);

    expect(countsBefore).toEqual({ name: 1, anonymous: 0, pending: 0 });
    expect(await getPrivacy(prisma, 'camila')).toEqual({ appearAs: AppearAs.ANONYMOUS, termVersion: CONSISTENCY_PRIVACY_TERM_VERSION, acceptedAt: TUESDAY });
    expect(await privacyCountsFor(prisma, ['camila'])).toEqual({ name: 0, anonymous: 1, pending: 0 });
    expect(prisma.rows.size).toBe(1);
  });

  it('APP-36 counts name, anonymous and pending participants', async () => {
    const prisma = privacyTable([
      { studentId: 'ana', appearAs: AppearAs.NAME, termVersion: CONSISTENCY_PRIVACY_TERM_VERSION, acceptedAt: MONDAY },
      { studentId: 'bruno', appearAs: AppearAs.NAME, termVersion: CONSISTENCY_PRIVACY_TERM_VERSION, acceptedAt: MONDAY },
      { studentId: 'marcos', appearAs: AppearAs.ANONYMOUS, termVersion: CONSISTENCY_PRIVACY_TERM_VERSION, acceptedAt: MONDAY },
      { studentId: 'lucas', appearAs: AppearAs.NAME, termVersion: '2020-01-v0', acceptedAt: MONDAY },
      { studentId: 'outro-time', appearAs: AppearAs.ANONYMOUS, termVersion: CONSISTENCY_PRIVACY_TERM_VERSION, acceptedAt: MONDAY },
    ]);

    const counts = await privacyCountsFor(prisma, ['ana', 'bruno', 'marcos', 'lucas', 'camila']);

    expect(counts).toEqual({ name: 2, anonymous: 1, pending: 2 });
    expect(await privacyCountsFor(prisma, [])).toEqual({ name: 0, anonymous: 0, pending: 0 });
  });
});
