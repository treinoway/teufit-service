import 'dotenv/config';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import prismaClient from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { prisma as appPrisma } from '../../src/db.js';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { provisionTrainerPlan } from '../helpers/platform-plan.js';
import { seedLegacyUnverifiedUser } from '../helpers/legacy-user.js';
import { createTrainerWithToken } from '../helpers/admin-users.js';
import emailHandler from '../../src/config/email-handler.js';
import { PLATFORM_PLAN_TIERS } from '../../src/constants/platform-plan.js';
import { StudentInviteStatus } from '../../src/constants/student-invite.js';

/**
 * The consent migration adds student_invites.requires_consent AND backfills it: a pending invite whose
 * address already belongs to a user was created before the consent rule existed, so it must wait for the
 * answer of that user instead of being accepted automatically when the user verifies the e-mail.
 *
 * The first scenario runs on its own throwaway database inside the Testcontainers Postgres: every migration
 * BEFORE the one under test is applied, legacy rows are created, then the migration SQL is executed. The
 * second scenario replays the same SQL on the worker database (already migrated) and drives the real app,
 * which is why the whole SQL has to be safe to run again.
 *
 * The migration directory is found by its suffix so its timestamp stays free.
 */

const MIGRATION_SUFFIX = '_add_student_invite_requires_consent';
const MIGRATIONS_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');

const DECLINED_STATUS = 'declined';
const NON_PENDING_STATUSES = [
  StudentInviteStatus.ACCEPTED,
  StudentInviteStatus.REVOKED,
  StudentInviteStatus.EXPIRED,
  DECLINED_STATUS,
];
const EXISTING_USER_EMAIL = 'consent-backfill-existing@example.com';
const STORED_MIXED_CASE_EMAIL = 'Consent.Backfill.Mixed@Example.com';
const MIXED_CASE_INVITE_EMAIL = STORED_MIXED_CASE_EMAIL.toLowerCase();
const HISTORY_USER_EMAIL = 'consent-backfill-history@example.com';
const NO_USER_EMAIL = 'consent-backfill-nobody@example.com';
const TRAINER_EMAIL = 'consent-backfill-trainer@example.com';
const PASSWORD = 'StrongPassw0rd!';
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const DELIVERED = { data: { id: 'email-id' } };
const INVITE_SNAPSHOT_SQL = 'SELECT id, status, requires_consent FROM student_invites ORDER BY id';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const { PrismaClient } = prismaClient;

// Returns the connection string pointing at another database of the same server.
function withDatabaseName(connectionString, databaseName) {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

// Runs a SQL script (or a parameterized query) on a fresh connection and returns its rows.
async function runSql(connectionString, sql, params) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query(sql, params);
    return result.rows;
  } finally {
    await client.end();
  }
}

// Lists every migration directory name, sorted.
function listMigrations() {
  return readdirSync(MIGRATIONS_DIRECTORY, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

// Reads the SQL of one migration directory.
function readMigrationSql(migrationName) {
  return readFileSync(path.join(MIGRATIONS_DIRECTORY, migrationName, 'migration.sql'), 'utf8');
}

// Inserts a legacy invite row (the consent column does not exist yet) and returns its id.
async function insertLegacyInvite(connectionString, { trainerId, email, status = StudentInviteStatus.PENDING }) {
  const id = randomUUID();
  await runSql(
    connectionString,
    'INSERT INTO student_invites (id, trainer_id, email, status, expires_at) VALUES ($1, $2, $3, $4, $5)',
    [id, trainerId, email, status, new Date(Date.now() + ONE_DAY_MS)],
  );
  return id;
}

// Reads the consent flag of one invite.
async function readRequiresConsent(connectionString, inviteId) {
  const [row] = await runSql(connectionString, 'SELECT requires_consent FROM student_invites WHERE id = $1', [inviteId]);
  return row?.requires_consent;
}

e2eDescribe('e2e: migration — pending invites to an existing account wait for consent', () => {
  const serverUrl = process.env.DATABASE_URL;
  const migrationName = listMigrations().find((name) => name.endsWith(MIGRATION_SUFFIX));
  let databaseName;
  let connectionString;
  let pool;
  let prisma;
  let invites;
  let migrationSql;

  beforeAll(async () => {
    expect(migrationName, `no migration directory ends with ${MIGRATION_SUFFIX}`).toBeDefined();
    migrationSql = readMigrationSql(migrationName);

    databaseName = `migration_check_${randomUUID().replace(/-/g, '')}`;
    await runSql(serverUrl, `CREATE DATABASE ${databaseName}`);
    connectionString = withDatabaseName(serverUrl, databaseName);
    for (const migration of listMigrations().filter((name) => name < migrationName)) {
      await runSql(connectionString, readMigrationSql(migration));
    }

    pool = new pg.Pool({ connectionString });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

    const trainerUser = await prisma.user.create({ data: { email: TRAINER_EMAIL, roles: ['trainer'] }, select: { id: true } });
    const trainer = await prisma.trainer.create({ data: { userId: trainerUser.id }, select: { id: true } });
    await prisma.user.create({ data: { email: EXISTING_USER_EMAIL, roles: [] }, select: { id: true } });
    await prisma.user.create({ data: { email: STORED_MIXED_CASE_EMAIL, roles: [] }, select: { id: true } });
    await prisma.user.create({ data: { email: HISTORY_USER_EMAIL, roles: [] }, select: { id: true } });

    invites = {
      pendingToExistingUser: await insertLegacyInvite(connectionString, { trainerId: trainer.id, email: EXISTING_USER_EMAIL }),
      pendingToMixedCaseUser: await insertLegacyInvite(connectionString, { trainerId: trainer.id, email: MIXED_CASE_INVITE_EMAIL }),
      pendingToNobody: await insertLegacyInvite(connectionString, { trainerId: trainer.id, email: NO_USER_EMAIL }),
    };
    for (const status of NON_PENDING_STATUSES) {
      invites[status] = await insertLegacyInvite(connectionString, { trainerId: trainer.id, email: HISTORY_USER_EMAIL, status });
    }

    await runSql(connectionString, migrationSql);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end().catch(() => {});
    if (databaseName) {
      await runSql(serverUrl, `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    }
  });

  describe('invites that now wait for consent', () => {
    it('flags a pending invite whose address belongs to an existing user', async () => {
      expect(await readRequiresConsent(connectionString, invites.pendingToExistingUser)).toBe(true);
    });

    it('flags a pending invite whose address matches a user e-mail stored with another letter case', async () => {
      expect(await readRequiresConsent(connectionString, invites.pendingToMixedCaseUser)).toBe(true);
    });
  });

  describe('invites that are left alone', () => {
    it('keeps a pending invite to an address without any user automatic', async () => {
      expect(await readRequiresConsent(connectionString, invites.pendingToNobody)).toBe(false);
    });

    it.each(NON_PENDING_STATUSES)('keeps a %s invite to an existing user unflagged', async (status) => {
      expect(await readRequiresConsent(connectionString, invites[status])).toBe(false);
    });

    it('changes the status of no invite', async () => {
      const rows = await runSql(connectionString, 'SELECT status, COUNT(*)::int AS total FROM student_invites GROUP BY status ORDER BY status');

      expect(rows).toEqual(
        [
          { status: StudentInviteStatus.ACCEPTED, total: 1 },
          { status: DECLINED_STATUS, total: 1 },
          { status: StudentInviteStatus.EXPIRED, total: 1 },
          { status: StudentInviteStatus.PENDING, total: 3 },
          { status: StudentInviteStatus.REVOKED, total: 1 },
        ].sort((left, right) => left.status.localeCompare(right.status)),
      );
    });
  });

  describe('whole table', () => {
    it('is idempotent: running the SQL again does not fail and changes no row', async () => {
      const before = await runSql(connectionString, INVITE_SNAPSHOT_SQL);

      await runSql(connectionString, migrationSql);

      const after = await runSql(connectionString, INVITE_SNAPSHOT_SQL);
      expect(after).toEqual(before);
    });
  });
});

e2eDescribe('e2e: a backfilled invite is answered in the app, never auto-accepted', () => {
  const workerDatabaseUrl = process.env.DATABASE_URL;
  const migrationName = listMigrations().find((name) => name.endsWith(MIGRATION_SUFFIX));
  let app;
  let verificationCodes;

  const auth = (token) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
    verificationCodes = new Map();
    vi.spyOn(emailHandler, 'sendEmailVerificationEmail').mockImplementation(async ({ to, code }) => {
      verificationCodes.set(to.toLowerCase(), code);
      return DELIVERED;
    });
  });

  async function seedLegacyPendingInvite() {
    const trainer = await createTrainerWithToken(app, { firstName: 'Ana', lastName: 'Coach' });
    await provisionTrainerPlan(trainer.trainerId, PLATFORM_PLAN_TIERS.DIAMOND);
    const student = await seedLegacyUnverifiedUser(app, { email: `e2e+backfill-${Date.now()}@example.com`, password: PASSWORD });
    const invite = await appPrisma.studentInvite.create({
      data: {
        trainerId: trainer.trainerId,
        email: student.email,
        status: StudentInviteStatus.PENDING,
        requiresConsent: false,
        expiresAt: new Date(Date.now() + ONE_DAY_MS),
      },
      select: { id: true },
    });
    return { student, inviteId: invite.id };
  }

  it('should not link the invited user on verify-email and should list the invite in GET /my/trainer/invites', async () => {
    const { student, inviteId } = await seedLegacyPendingInvite();

    await runSql(workerDatabaseUrl, readMigrationSql(migrationName));
    const verified = await app.inject({
      method: 'POST',
      url: '/auth/verify-email',
      headers: auth(student.accessToken),
      payload: { code: verificationCodes.get(student.email) },
    });
    const listed = await app.inject({ method: 'GET', url: '/my/trainer/invites', headers: auth(student.accessToken) });

    expect(verified.statusCode, verified.body).toBe(200);
    expect(verified.json()).toMatchObject({ verified: true, linkedTrainers: 0 });
    expect(await appPrisma.trainerStudent.count({ where: { studentId: student.userId } })).toBe(0);
    expect(await appPrisma.studentInvite.findUnique({ where: { id: inviteId } })).toMatchObject({
      status: StudentInviteStatus.PENDING,
      requiresConsent: true,
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().items.map((item) => item.id)).toEqual([inviteId]);
  });
});
