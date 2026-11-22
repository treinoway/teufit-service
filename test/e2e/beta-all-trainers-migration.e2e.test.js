import 'dotenv/config';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import prismaClient from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

/**
 * The open-signup migration moves EXISTING trainers to BETA: the ones with no platform subscription
 * row and the ones on FREE that do not pay through Asaas. The scenario runs on its own throwaway
 * database inside the Testcontainers Postgres: every migration BEFORE the one under test is applied,
 * legacy rows are created, then the migration SQL is executed and the result asserted.
 *
 * The migration directory is found by its suffix so its timestamp stays free.
 */

const MIGRATION_SUFFIX = '_backfill_beta_all_trainers';
const MIGRATIONS_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');

const BETA = 'BETA';
const FREE = 'FREE';
const PRO = 'PRO';
const PLATINUM = 'PLATINUM';
const DIAMOND = 'DIAMOND';
const ACTIVE = 'ACTIVE';
const PAST_DUE = 'PAST_DUE';
const PAST_DUE_SINCE = new Date('2026-11-10T00:00:00.000Z');

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

// Reads the subscription rows of one trainer.
function readSubscriptions(connectionString, trainerId) {
  return runSql(
    connectionString,
    `SELECT tier::text AS tier, status::text AS status, asaas_subscription_id, past_due_since
     FROM platform_subscriptions WHERE trainer_id = $1`,
    [trainerId],
  );
}

// Reads whether each student link of one trainer is active on the plan.
async function readActiveOnPlanFlags(connectionString, trainerId) {
  const rows = await runSql(connectionString, 'SELECT active_on_plan FROM trainer_students WHERE trainer_id = $1', [trainerId]);
  return rows.map((row) => row.active_on_plan);
}

e2eDescribe('e2e: migration — every existing trainer without a paid plan becomes BETA', () => {
  const serverUrl = process.env.DATABASE_URL;
  const migrationName = listMigrations().find((name) => name.endsWith(MIGRATION_SUFFIX));
  let databaseName;
  let connectionString;
  let pool;
  let prisma;
  let seq = 0;
  let trainers;
  let migrationSql;

  async function createUser() {
    seq += 1;
    return prisma.user.create({ data: { email: `beta-backfill-${seq}@example.com`, roles: ['trainer'] }, select: { id: true } });
  }

  async function createTrainer(subscription) {
    const user = await createUser();
    const trainer = await prisma.trainer.create({ data: { userId: user.id }, select: { id: true } });
    if (subscription) {
      await prisma.platformSubscription.create({ data: { trainerId: trainer.id, ...subscription }, select: { id: true } });
    }
    return trainer.id;
  }

  async function linkBlockedStudent(trainerId) {
    const student = await createUser();
    await prisma.trainerStudent.create({
      data: { trainerId, studentId: student.id, activeOnPlan: false },
      select: { trainerId: true },
    });
  }

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

    trainers = {
      withoutSubscription: await createTrainer(null),
      freeWithoutAsaas: await createTrainer({ tier: FREE, status: ACTIVE }),
      freeWithAsaasCheckout: await createTrainer({ tier: FREE, status: ACTIVE, asaasSubscriptionId: 'sub_free_checkout' }),
      paidPro: await createTrainer({ tier: PRO, status: ACTIVE, asaasSubscriptionId: 'sub_paid_pro' }),
      pastDuePlatinum: await createTrainer({
        tier: PLATINUM,
        status: PAST_DUE,
        asaasSubscriptionId: 'sub_past_due_platinum',
        pastDueSince: PAST_DUE_SINCE,
      }),
      adminDiamond: await createTrainer({ tier: DIAMOND, status: ACTIVE }),
      alreadyBeta: await createTrainer({ tier: BETA, status: ACTIVE }),
    };
    await linkBlockedStudent(trainers.withoutSubscription);
    await linkBlockedStudent(trainers.freeWithoutAsaas);
    await linkBlockedStudent(trainers.paidPro);

    await runSql(connectionString, migrationSql);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end().catch(() => {});
    if (databaseName) {
      await runSql(serverUrl, `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    }
  });

  describe('trainers that become BETA', () => {
    it('creates an ACTIVE BETA subscription for a trainer with no subscription row', async () => {
      const rows = await readSubscriptions(connectionString, trainers.withoutSubscription);

      expect(rows).toEqual([{ tier: BETA, status: ACTIVE, asaas_subscription_id: null, past_due_since: null }]);
    });

    it('moves a FREE subscription without an Asaas subscription to ACTIVE BETA', async () => {
      const rows = await readSubscriptions(connectionString, trainers.freeWithoutAsaas);

      expect(rows).toEqual([{ tier: BETA, status: ACTIVE, asaas_subscription_id: null, past_due_since: null }]);
    });

    it.each(['withoutSubscription', 'freeWithoutAsaas'])(
      'reactivates the students that the FREE cap had blocked (%s)',
      async (trainerKey) => {
        const flags = await readActiveOnPlanFlags(connectionString, trainers[trainerKey]);

        expect(flags).toEqual([true]);
      },
    );
  });

  describe('trainers that are left alone', () => {
    it('keeps a FREE subscription that has an Asaas subscription attached', async () => {
      const rows = await readSubscriptions(connectionString, trainers.freeWithAsaasCheckout);

      expect(rows).toEqual([{ tier: FREE, status: ACTIVE, asaas_subscription_id: 'sub_free_checkout', past_due_since: null }]);
    });

    it('keeps a paid PRO subscription', async () => {
      const rows = await readSubscriptions(connectionString, trainers.paidPro);

      expect(rows).toEqual([{ tier: PRO, status: ACTIVE, asaas_subscription_id: 'sub_paid_pro', past_due_since: null }]);
    });

    it('keeps a past-due paid subscription, including its grace period start', async () => {
      const rows = await readSubscriptions(connectionString, trainers.pastDuePlatinum);

      expect(rows).toEqual([
        { tier: PLATINUM, status: PAST_DUE, asaas_subscription_id: 'sub_past_due_platinum', past_due_since: PAST_DUE_SINCE },
      ]);
    });

    it('keeps an admin-granted DIAMOND subscription', async () => {
      const rows = await readSubscriptions(connectionString, trainers.adminDiamond);

      expect(rows).toEqual([{ tier: DIAMOND, status: ACTIVE, asaas_subscription_id: null, past_due_since: null }]);
    });

    it('keeps an existing BETA subscription as a single row', async () => {
      const rows = await readSubscriptions(connectionString, trainers.alreadyBeta);

      expect(rows).toEqual([{ tier: BETA, status: ACTIVE, asaas_subscription_id: null, past_due_since: null }]);
    });

    it('keeps the blocked students of a paying trainer blocked', async () => {
      const flags = await readActiveOnPlanFlags(connectionString, trainers.paidPro);

      expect(flags).toEqual([false]);
    });
  });

  describe('whole table', () => {
    it('leaves every trainer with exactly one subscription row', async () => {
      const rows = await runSql(
        connectionString,
        `SELECT t.id FROM trainers t
         LEFT JOIN platform_subscriptions s ON s.trainer_id = t.id
         GROUP BY t.id HAVING COUNT(s.id) <> 1`,
      );

      expect(rows).toEqual([]);
    });

    it('is idempotent: running the SQL again does not fail and changes no tier', async () => {
      const before = await runSql(connectionString, 'SELECT trainer_id, tier::text AS tier, status::text AS status FROM platform_subscriptions ORDER BY trainer_id');

      await runSql(connectionString, migrationSql);

      const after = await runSql(connectionString, 'SELECT trainer_id, tier::text AS tier, status::text AS status FROM platform_subscriptions ORDER BY trainer_id');
      expect(after).toEqual(before);
    });
  });
});
