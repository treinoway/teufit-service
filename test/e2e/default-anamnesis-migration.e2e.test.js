import 'dotenv/config';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import prismaClient from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { seedPublicAnamnesis, caveiraSections } from '../../prisma/seed.js';
import { isQuestionVisible } from '../../src/constants/anamnesis.js';
import {
  LEGACY_DEFAULT_ANAMNESIS_TITLE,
  legacyDefaultAnamnesisSections,
} from '../fixtures/legacy-default-anamnesis.js';

/**
 * Migration 20260930120000_update_default_anamnesis_structure upgrades the default public
 * anamnesis ("Anamnese Completa") of EXISTING databases from the old 14-section layout to the
 * new 10-section one. Each scenario runs on its own throwaway database created inside the
 * Testcontainers Postgres: every migration BEFORE the one under test is applied, the legacy
 * structure is built, then the migration SQL is executed and the result asserted.
 */

const MIGRATION_NAME = '20260930120000_update_default_anamnesis_structure';
const MIGRATIONS_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');
const migrationSql = readFileSync(path.join(MIGRATIONS_DIRECTORY, MIGRATION_NAME, 'migration.sql'), 'utf8');

const REMOVED_SECTION_TITLES = [
  '03 — Hábitos de Vida',
  '08 — Avaliação Clínica',
  '10 — Hábitos Alimentares e Suplementação',
  '11 — Relação com Alimentação',
];

const TARGET_SECTION_TITLES = [
  '01 — Identificação',
  '02 — Objetivo e Expectativa',
  '03 — Hábitos de Sono',
  '04 — Estresse e Contexto de Vida',
  '05 — Histórico Médico',
  '06 — Histórico de Lesões e Limitações',
  '07 — Postura e Mobilidade',
  '08 — Treino de Musculação',
  '09 — Exercício Aeróbico',
  '10 — Ciclo Menstrual',
];

const MENSTRUAL_TRIGGER_TEXT = 'Você menstrua?';
const MENSTRUAL_CONDITION = { operator: 'equals', value: 'yes' };
const LEGACY_MENSTRUAL_SECTION_TITLE = '14 — Ciclo Menstrual';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const { PrismaClient } = prismaClient;

function withDatabaseName(connectionString, databaseName) {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function runSql(connectionString, sql) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

function listMigrationsBefore(migrationName) {
  return readdirSync(MIGRATIONS_DIRECTORY, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name < migrationName)
    .map((entry) => entry.name)
    .sort();
}

function buildLegacyQuestionCreate(question) {
  return {
    text: question.text,
    type: question.type,
    required: question.required ?? false,
    order: question.order,
    options: question.options?.length
      ? { create: question.options.map((option) => ({ text: option.text, order: option.order })) }
      : undefined,
  };
}

async function createLegacyDefaultAnamnesis(prisma, overrides = {}) {
  return prisma.anamnesis.create({
    data: {
      trainerId: null,
      title: LEGACY_DEFAULT_ANAMNESIS_TITLE,
      description: 'Diagnóstico individualizado. Sem atalhos. Sem planilha de gaveta.',
      isGeneral: true,
      ...overrides,
      sections: {
        create: legacyDefaultAnamnesisSections.map((section) => ({
          title: section.title,
          description: section.description ?? null,
          order: section.order,
          questions: { create: section.questions.map(buildLegacyQuestionCreate) },
        })),
      },
    },
    select: { id: true },
  });
}

/**
 * Live (non-deleted) structure of an anamnesis in an id-independent shape, so a migrated
 * database and a freshly seeded one can be compared with toEqual.
 */
async function readLiveStructure(prisma, anamnesisId) {
  const sections = await prisma.anamnesisSection.findMany({
    where: { anamnesisId, deletedAt: null },
    orderBy: { order: 'asc' },
    include: {
      questions: {
        where: { deletedAt: null },
        orderBy: { order: 'asc' },
        include: { options: { orderBy: { order: 'asc' } } },
      },
    },
  });

  return sections.map((section) => {
    const textById = new Map(section.questions.map((question) => [question.id, question.text]));
    return {
      title: section.title,
      description: section.description,
      order: section.order,
      questions: section.questions.map((question) => ({
        order: question.order,
        text: question.text,
        type: question.type,
        required: question.required,
        parentText: question.parentQuestionId ? textById.get(question.parentQuestionId) : null,
        condition: question.condition,
        options: question.options.map((option) => ({ order: option.order, text: option.text })),
      })),
    };
  });
}

async function snapshotRows(prisma, anamnesisId) {
  const sections = await prisma.anamnesisSection.findMany({
    where: { anamnesisId },
    orderBy: [{ order: 'asc' }, { title: 'asc' }],
    include: { questions: { orderBy: [{ order: 'asc' }, { text: 'asc' }] } },
  });
  return JSON.parse(JSON.stringify(sections));
}

e2eDescribe('e2e: migration — update default anamnesis structure', () => {
  const serverUrl = process.env.DATABASE_URL;
  const createdDatabases = [];
  const openClients = [];

  async function createDatabaseBeforeMigration() {
    const databaseName = `migration_check_${randomUUID().replace(/-/g, '')}`;
    await runSql(serverUrl, `CREATE DATABASE ${databaseName}`);
    createdDatabases.push(databaseName);

    const connectionString = withDatabaseName(serverUrl, databaseName);
    for (const migration of listMigrationsBefore(MIGRATION_NAME)) {
      await runSql(connectionString, readFileSync(path.join(MIGRATIONS_DIRECTORY, migration, 'migration.sql'), 'utf8'));
    }

    const pool = new pg.Pool({ connectionString });
    const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    openClients.push({ prisma, pool });

    return { connectionString, prisma };
  }

  afterAll(async () => {
    for (const { prisma, pool } of openClients) {
      await prisma.$disconnect();
      await pool.end().catch(() => {});
    }
    for (const databaseName of createdDatabases) {
      await runSql(serverUrl, `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    }
  });

  describe('existing database with the old 14-section default anamnesis', () => {
    let connectionString;
    let prisma;
    let defaultAnamnesisId;
    let untouched;
    let removedQuestionAnswerId;
    let legacyMenstrualQuestionIds;

    beforeAll(async () => {
      ({ connectionString, prisma } = await createDatabaseBeforeMigration());

      const trainerUser = await prisma.user.create({ data: { email: 'trainer-migration@example.com', roles: ['TRAINER'] } });
      const trainer = await prisma.trainer.create({ data: { userId: trainerUser.id } });
      const studentUser = await prisma.user.create({ data: { email: 'student-migration@example.com', roles: ['STUDENT'] } });

      const defaultAnamnesis = await createLegacyDefaultAnamnesis(prisma);
      defaultAnamnesisId = defaultAnamnesis.id;

      // Same titles, but NOT the default one: a trainer's copy, a soft-deleted default, and a
      // non-general anamnesis without trainer. None of them may be touched.
      const trainerCopy = await createLegacyDefaultAnamnesis(prisma, { trainerId: trainer.id, isGeneral: false });
      const deletedDefault = await createLegacyDefaultAnamnesis(prisma, { deletedAt: new Date() });
      const differentTitle = await createLegacyDefaultAnamnesis(prisma, { title: 'Outra anamnese geral' });
      untouched = {
        trainerCopyId: trainerCopy.id,
        deletedDefaultId: deletedDefault.id,
        differentTitleId: differentTitle.id,
        snapshots: {
          trainerCopy: await snapshotRows(prisma, trainerCopy.id),
          deletedDefault: await snapshotRows(prisma, deletedDefault.id),
          differentTitle: await snapshotRows(prisma, differentTitle.id),
        },
      };

      // A response of a student that answered a question of a removed section and a menstrual one.
      await prisma.studentAnamnesis.create({
        data: { anamnesisId: defaultAnamnesisId, studentId: studentUser.id, trainerId: trainer.id },
      });
      const response = await prisma.anamnesisResponse.create({
        data: { anamnesisId: defaultAnamnesisId, studentId: studentUser.id, submittedAt: new Date() },
      });

      const questions = await prisma.anamnesisQuestion.findMany({
        where: { section: { anamnesisId: defaultAnamnesisId } },
        include: { section: true },
      });
      const removedQuestion = questions.find((question) => question.section.title === REMOVED_SECTION_TITLES[0]);
      legacyMenstrualQuestionIds = questions
        .filter((question) => question.section.title === LEGACY_MENSTRUAL_SECTION_TITLE)
        .map((question) => question.id);
      const answer = await prisma.anamnesisAnswer.create({
        data: { responseId: response.id, questionId: removedQuestion.id, value: 'ainda existe no banco' },
      });
      removedQuestionAnswerId = answer.id;
      await prisma.anamnesisAnswer.create({
        data: { responseId: response.id, questionId: legacyMenstrualQuestionIds[0], value: 'yes' },
      });

      await runSql(connectionString, migrationSql);
    });

    it('leaves exactly the 10 target sections, renumbered and re-ordered 0..9', async () => {
      const sections = await prisma.anamnesisSection.findMany({
        where: { anamnesisId: defaultAnamnesisId, deletedAt: null },
        orderBy: { order: 'asc' },
      });

      expect(sections.map((section) => section.title)).toEqual(TARGET_SECTION_TITLES);
      expect(sections.map((section) => section.order)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    it('soft-deletes (never hard-deletes) the 4 removed sections and all their questions', async () => {
      const removedSections = await prisma.anamnesisSection.findMany({
        where: { anamnesisId: defaultAnamnesisId, title: { in: REMOVED_SECTION_TITLES } },
        include: { questions: true },
      });

      expect(removedSections).toHaveLength(REMOVED_SECTION_TITLES.length);
      for (const section of removedSections) {
        expect(section.deletedAt).not.toBeNull();
        expect(section.questions.length).toBeGreaterThan(0);
        expect(section.questions.every((question) => question.deletedAt !== null)).toBe(true);
      }
    });

    it('keeps existing answers, including the ones to soft-deleted questions', async () => {
      const answers = await prisma.anamnesisAnswer.count();
      const answerToRemovedQuestion = await prisma.anamnesisAnswer.findUnique({ where: { id: removedQuestionAnswerId } });

      expect(answers).toBe(2);
      expect(answerToRemovedQuestion.value).toBe('ainda existe no banco');
    });

    it('adds "Você menstrua?" first and turns the 5 old menstrual questions into conditional children', async () => {
      const section = await prisma.anamnesisSection.findFirst({
        where: { anamnesisId: defaultAnamnesisId, title: '10 — Ciclo Menstrual', deletedAt: null },
        include: { questions: { where: { deletedAt: null }, orderBy: { order: 'asc' } } },
      });
      const [trigger, ...children] = section.questions;

      expect(trigger).toMatchObject({
        text: MENSTRUAL_TRIGGER_TEXT,
        type: 'dichotomous',
        required: false,
        order: 0,
        parentQuestionId: null,
        condition: null,
      });
      expect(children.map((question) => question.order)).toEqual([1, 2, 3, 4, 5]);
      expect(children.map((question) => question.id).sort()).toEqual([...legacyMenstrualQuestionIds].sort());
      for (const child of children) {
        expect(child.parentQuestionId).toBe(trigger.id);
        expect(child.condition).toEqual(MENSTRUAL_CONDITION);
        expect(child.required).toBe(false);
      }

      const noAnswer = new Map();
      expect(isQuestionVisible(children[0], noAnswer)).toBe(false);
      expect(isQuestionVisible(children[0], new Map([[trigger.id, 'no']]))).toBe(false);
      expect(isQuestionVisible(children[0], new Map([[trigger.id, 'yes']]))).toBe(true);
    });

    it('produces the same live structure as a freshly seeded database', async () => {
      const { prisma: freshPrisma } = await createDatabaseBeforeMigration();
      const seeded = await seedPublicAnamnesis(freshPrisma);

      const migratedStructure = await readLiveStructure(prisma, defaultAnamnesisId);
      const seededStructure = await readLiveStructure(freshPrisma, seeded.id);

      expect(migratedStructure).toEqual(seededStructure);
    });

    it('does not touch trainer copies, soft-deleted or differently titled anamneses', async () => {
      expect(await snapshotRows(prisma, untouched.trainerCopyId)).toEqual(untouched.snapshots.trainerCopy);
      expect(await snapshotRows(prisma, untouched.deletedDefaultId)).toEqual(untouched.snapshots.deletedDefault);
      expect(await snapshotRows(prisma, untouched.differentTitleId)).toEqual(untouched.snapshots.differentTitle);
    });

    it('is idempotent: running the SQL again changes nothing and does not fail', async () => {
      const before = await snapshotRows(prisma, defaultAnamnesisId);

      await runSql(connectionString, migrationSql);

      expect(await snapshotRows(prisma, defaultAnamnesisId)).toEqual(before);
      const triggers = await prisma.anamnesisQuestion.count({
        where: { text: MENSTRUAL_TRIGGER_TEXT, section: { anamnesisId: defaultAnamnesisId } },
      });
      expect(triggers).toBe(1);
    });
  });

  describe('databases where there is nothing to migrate', () => {
    it('is a no-op on a fresh database (no anamnesis yet) and the seed then builds the new structure', async () => {
      const { connectionString, prisma } = await createDatabaseBeforeMigration();

      await runSql(connectionString, migrationSql);

      expect(await prisma.anamnesis.count()).toBe(0);
      expect(await prisma.anamnesisSection.count()).toBe(0);
      expect(await prisma.anamnesisQuestion.count()).toBe(0);

      const seeded = await seedPublicAnamnesis(prisma);
      const structure = await readLiveStructure(prisma, seeded.id);

      expect(structure.map((section) => section.title)).toEqual(TARGET_SECTION_TITLES);
    });

    it('does not fail nor change anything when the titles were already changed (re-run on migrated data)', async () => {
      const { connectionString, prisma } = await createDatabaseBeforeMigration();
      const seeded = await seedPublicAnamnesis(prisma);
      const before = await snapshotRows(prisma, seeded.id);

      await runSql(connectionString, migrationSql);

      expect(await snapshotRows(prisma, seeded.id)).toEqual(before);
    });

    it('only upgrades the sections whose current title is the legacy one (partially renamed data)', async () => {
      const { connectionString, prisma } = await createDatabaseBeforeMigration();
      const { id } = await createLegacyDefaultAnamnesis(prisma);
      await prisma.anamnesisSection.updateMany({
        where: { anamnesisId: id, title: LEGACY_MENSTRUAL_SECTION_TITLE },
        data: { title: 'Ciclo (renomeado por um admin)' },
      });

      await runSql(connectionString, migrationSql);

      const renamed = await prisma.anamnesisSection.findFirst({
        where: { anamnesisId: id, title: 'Ciclo (renomeado por um admin)' },
        include: { questions: true },
      });
      expect(renamed.order).toBe(13);
      expect(renamed.questions).toHaveLength(5);
      expect(renamed.questions.every((question) => question.parentQuestionId === null)).toBe(true);

      const liveTitles = (
        await prisma.anamnesisSection.findMany({ where: { anamnesisId: id, deletedAt: null }, orderBy: { order: 'asc' } })
      ).map((section) => section.title);
      expect(liveTitles).toContain('03 — Hábitos de Sono');
      expect(liveTitles).not.toContain(REMOVED_SECTION_TITLES[0]);
    });
  });

  describe('seed (fresh database)', () => {
    let prisma;
    let anamnesisId;

    beforeAll(async () => {
      ({ prisma } = await createDatabaseBeforeMigration());
      anamnesisId = (await seedPublicAnamnesis(prisma)).id;
    });

    it('creates the 10 sections with titles "NN — Name" and orders 0..9', async () => {
      const structure = await readLiveStructure(prisma, anamnesisId);

      expect(structure.map((section) => section.title)).toEqual(TARGET_SECTION_TITLES);
      expect(structure.map((section) => section.order)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(structure).toHaveLength(caveiraSections.length);
    });

    it('does not contain the removed sections', async () => {
      const titles = (await readLiveStructure(prisma, anamnesisId)).map((section) => section.title);

      for (const removedTitle of REMOVED_SECTION_TITLES) {
        expect(titles).not.toContain(removedTitle);
      }
    });

    it('builds "Ciclo Menstrual" with the trigger question and 5 valid conditional children, all optional', async () => {
      const section = await prisma.anamnesisSection.findFirst({
        where: { anamnesisId, title: '10 — Ciclo Menstrual' },
        include: { questions: { orderBy: { order: 'asc' } } },
      });
      const [trigger, ...children] = section.questions;

      expect(trigger).toMatchObject({ text: MENSTRUAL_TRIGGER_TEXT, type: 'dichotomous', order: 0, parentQuestionId: null });
      expect(children).toHaveLength(5);
      expect(children.map((question) => question.order)).toEqual([1, 2, 3, 4, 5]);
      expect(section.questions.every((question) => question.required === false)).toBe(true);

      for (const child of children) {
        expect(child.sectionId).toBe(trigger.sectionId);
        expect(child.parentQuestionId).toBe(trigger.id);
        expect(child.condition).toEqual(MENSTRUAL_CONDITION);
        expect(isQuestionVisible(child, new Map([[trigger.id, 'yes']]))).toBe(true);
        expect(isQuestionVisible(child, new Map([[trigger.id, 'no']]))).toBe(false);
        expect(isQuestionVisible(child, new Map())).toBe(false);
      }
    });

    it('has no conditional question outside the menstrual section', async () => {
      const conditionalOutside = await prisma.anamnesisQuestion.count({
        where: { parentQuestionId: { not: null }, section: { anamnesisId, title: { not: '10 — Ciclo Menstrual' } } },
      });

      expect(conditionalOutside).toBe(0);
    });

    it('is idempotent: seeding again skips and keeps a single default anamnesis', async () => {
      const second = await seedPublicAnamnesis(prisma);

      expect(second.id).toBe(anamnesisId);
      expect(await prisma.anamnesis.count({ where: { title: LEGACY_DEFAULT_ANAMNESIS_TITLE, isGeneral: true } })).toBe(1);
    });

    it('rolls back everything when the second pass fails (no half-built anamnesis left behind)', async () => {
      const { prisma: isolatedPrisma } = await createDatabaseBeforeMigration();
      const failingClient = {
        anamnesis: isolatedPrisma.anamnesis,
        $transaction: (callback) =>
          isolatedPrisma.$transaction((tx) =>
            callback({
              anamnesis: tx.anamnesis,
              anamnesisSection: { findMany: () => Promise.reject(new Error('second pass failed')) },
            }),
          ),
      };

      await expect(seedPublicAnamnesis(failingClient)).rejects.toThrow('second pass failed');
      expect(await isolatedPrisma.anamnesis.count()).toBe(0);
    });
  });
});
