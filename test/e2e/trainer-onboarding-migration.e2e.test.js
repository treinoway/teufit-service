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
 * Migration 20261027090000_add_trainer_onboarding_milestones adds the new milestone columns and
 * backfills them for EXISTING trainers. The scenario runs on its own throwaway database inside the
 * Testcontainers Postgres: every migration BEFORE the one under test is applied, legacy rows are
 * created, then the migration SQL is executed and the backfills asserted.
 */

const MIGRATION_NAME = '20261027090000_add_trainer_onboarding_milestones';
const MIGRATIONS_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');
const migrationSql = readFileSync(path.join(MIGRATIONS_DIRECTORY, MIGRATION_NAME, 'migration.sql'), 'utf8');

const FIRST_INVITE_AT = new Date('2026-01-10T10:00:00.000Z');
const LATER_INVITE_AT = new Date('2026-02-20T10:00:00.000Z');
const FIRST_ANAMNESIS_AT = new Date('2026-01-15T12:00:00.000Z');
const LATER_ANAMNESIS_AT = new Date('2026-03-01T12:00:00.000Z');
const BRANDING_AT = new Date('2026-01-20T08:00:00.000Z');
const EXISTING_PROFILE_COMPLETED_AT = new Date('2025-12-01T00:00:00.000Z');
const INVITE_EXPIRES_AT = new Date('2027-01-01T00:00:00.000Z');
const AVATAR_KEY = 'avatars/some-user.jpg';
const MIGRATION_RUN_TOLERANCE_MS = 60 * 1000;

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const { PrismaClient } = prismaClient;

// Returns the connection string pointing at another database of the same server.
function withDatabaseName(connectionString, databaseName) {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

// Runs a SQL script on a fresh connection to the given database.
async function runSql(connectionString, sql) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

// Lists the migration directory names that sort before the given one.
function listMigrationsBefore(migrationName) {
  return readdirSync(MIGRATIONS_DIRECTORY, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name < migrationName)
    .map((entry) => entry.name)
    .sort();
}

// Inserts a pending student invite listing only the columns that exist before the migration under test.
async function insertStudentInvite(connectionString, { trainerId, email, expiresAt, createdAt }) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    // why: the current Prisma client writes columns added by later migrations (requires_consent), absent in this database.
    await client.query(
      `INSERT INTO "student_invites" ("id", "trainer_id", "email", "expires_at", "created_at")
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), trainerId, email, expiresAt, createdAt],
    );
  } finally {
    await client.end();
  }
}

// Reads the four onboarding milestone columns of one trainer row.
async function readTrainerMilestones(connectionString, trainerId) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT first_student_invited_at, first_anamnesis_sent_at, branding_configured_at, profile_completed_at
       FROM trainers WHERE id = $1`,
      [trainerId],
    );
    return rows[0];
  } finally {
    await client.end();
  }
}

e2eDescribe('e2e: migration — add trainer onboarding milestones', () => {
  const serverUrl = process.env.DATABASE_URL;
  let databaseName;
  let connectionString;
  let pool;
  let prisma;
  let seq = 0;
  let trainers;
  let migratedAt;

  async function createUser(overrides = {}) {
    seq += 1;
    return prisma.user.create({
      data: { email: `migration-user-${seq}@example.com`, roles: ['trainer'], ...overrides },
      select: { id: true },
    });
  }

  async function createTrainer(userOverrides = {}) {
    const user = await createUser(userOverrides);
    const trainer = await prisma.trainer.create({ data: { userId: user.id }, select: { id: true } });
    return trainer.id;
  }

  async function createGeneralAnamnesis(trainerId) {
    return prisma.anamnesis.create({ data: { trainerId, title: `Anamnese ${randomUUID()}` }, select: { id: true } });
  }

  beforeAll(async () => {
    databaseName = `migration_check_${randomUUID().replace(/-/g, '')}`;
    await runSql(serverUrl, `CREATE DATABASE ${databaseName}`);
    connectionString = withDatabaseName(serverUrl, databaseName);
    for (const migration of listMigrationsBefore(MIGRATION_NAME)) {
      await runSql(connectionString, readFileSync(path.join(MIGRATIONS_DIRECTORY, migration, 'migration.sql'), 'utf8'));
    }

    pool = new pg.Pool({ connectionString });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

    const fullProfile = { firstName: 'Ana', lastName: 'Coach', avatarUrl: AVATAR_KEY };
    const student = await createUser({ roles: ['student'] });

    const activeTrainerId = await createTrainer(fullProfile);
    for (const createdAt of [LATER_INVITE_AT, FIRST_INVITE_AT]) {
      await insertStudentInvite(connectionString, {
        trainerId: activeTrainerId,
        email: `invite-${createdAt.getTime()}@example.com`,
        expiresAt: INVITE_EXPIRES_AT,
        createdAt,
      });
    }
    for (const createdAt of [LATER_ANAMNESIS_AT, FIRST_ANAMNESIS_AT]) {
      const anamnesis = await createGeneralAnamnesis(activeTrainerId);
      await prisma.studentAnamnesis.create({
        data: { anamnesisId: anamnesis.id, studentId: student.id, trainerId: activeTrainerId, createdAt },
        select: { id: true },
      });
    }
    await prisma.trainerBranding.create({
      data: { trainerId: activeTrainerId, primaryColor: '#FF5733', createdAt: BRANDING_AT },
      select: { id: true },
    });

    const blankLastNameTrainerId = await createTrainer({ firstName: 'Bia', lastName: '   ', avatarUrl: AVATAR_KEY });
    const noAvatarTrainerId = await createTrainer({ firstName: 'Caio', lastName: 'Silva' });
    const nullNamesTrainerId = await createTrainer({ avatarUrl: AVATAR_KEY });
    const alreadyCompletedTrainerId = await createTrainer(fullProfile);
    await runSql(
      connectionString,
      `UPDATE trainers SET profile_completed_at = '${EXISTING_PROFILE_COMPLETED_AT.toISOString()}' WHERE id = '${alreadyCompletedTrainerId}'`,
    );
    const emptyTrainerId = await createTrainer();

    trainers = {
      activeTrainerId,
      blankLastNameTrainerId,
      noAvatarTrainerId,
      nullNamesTrainerId,
      alreadyCompletedTrainerId,
      emptyTrainerId,
    };

    migratedAt = new Date();
    await runSql(connectionString, migrationSql);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end().catch(() => {});
    if (databaseName) {
      await runSql(serverUrl, `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    }
  });

  describe('first_student_invited_at backfill', () => {
    it('uses the MIN(created_at) of the trainer invites', async () => {
      const row = await readTrainerMilestones(connectionString, trainers.activeTrainerId);

      expect(row.first_student_invited_at).toEqual(FIRST_INVITE_AT);
    });

    it('stays null for trainers without invites', async () => {
      const row = await readTrainerMilestones(connectionString, trainers.emptyTrainerId);

      expect(row.first_student_invited_at).toBeNull();
    });
  });

  describe('first_anamnesis_sent_at backfill', () => {
    it('uses the MIN(created_at) of the trainer student anamneses', async () => {
      const row = await readTrainerMilestones(connectionString, trainers.activeTrainerId);

      expect(row.first_anamnesis_sent_at).toEqual(FIRST_ANAMNESIS_AT);
    });

    it('stays null for trainers without linked anamneses', async () => {
      const row = await readTrainerMilestones(connectionString, trainers.emptyTrainerId);

      expect(row.first_anamnesis_sent_at).toBeNull();
    });
  });

  describe('branding_configured_at backfill', () => {
    it('uses the created_at of the trainer branding', async () => {
      const row = await readTrainerMilestones(connectionString, trainers.activeTrainerId);

      expect(row.branding_configured_at).toEqual(BRANDING_AT);
    });

    it('stays null for trainers without branding', async () => {
      const row = await readTrainerMilestones(connectionString, trainers.emptyTrainerId);

      expect(row.branding_configured_at).toBeNull();
    });
  });

  describe('profile_completed_at backfill', () => {
    it('sets it to the migration time when firstName, lastName and avatar are all filled', async () => {
      const row = await readTrainerMilestones(connectionString, trainers.activeTrainerId);

      expect(row.profile_completed_at.getTime()).toBeGreaterThanOrEqual(migratedAt.getTime() - MIGRATION_RUN_TOLERANCE_MS);
    });

    it('stays null when lastName is only whitespace', async () => {
      const row = await readTrainerMilestones(connectionString, trainers.blankLastNameTrainerId);

      expect(row.profile_completed_at).toBeNull();
    });

    it('stays null when the avatar is missing', async () => {
      const row = await readTrainerMilestones(connectionString, trainers.noAvatarTrainerId);

      expect(row.profile_completed_at).toBeNull();
    });

    it('stays null when the names are null', async () => {
      const row = await readTrainerMilestones(connectionString, trainers.nullNamesTrainerId);

      expect(row.profile_completed_at).toBeNull();
    });

    it('keeps an already set profile_completed_at untouched', async () => {
      const row = await readTrainerMilestones(connectionString, trainers.alreadyCompletedTrainerId);

      expect(row.profile_completed_at).toEqual(EXISTING_PROFILE_COMPLETED_AT);
    });
  });

  describe('example flags', () => {
    it('adds is_example defaulting to false on protocol templates and training templates', async () => {
      const trainerId = trainers.emptyTrainerId;
      const protocolTemplate = await prisma.trainingProtocolTemplate.create({ data: { trainerId, name: 'Rotina' } });
      const trainingTemplate = await prisma.trainingTemplate.create({
        data: { trainerId, name: 'Treino', category: 'strength' },
      });

      expect(protocolTemplate.isExample).toBe(false);
      expect(trainingTemplate.isExample).toBe(false);
    });
  });
});
