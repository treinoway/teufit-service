import { prisma } from '../../src/db.js';

const TABLES = [
  'anamnesis_answers',
  'anamnesis_responses',
  'student_anamneses',
  'anamnesis_question_options',
  'anamnesis_questions',
  'anamnesis_sections',
  'anamneses',
  'protocol_template_trainings',
  'trainings',
  'training_protocols',
  'training_templates',
  'training_protocol_templates',
  'trainer_students',
  'challenge_participants',
  'challenges',
  'point_transactions',
  'point_balances',
  'gamification_configs',
  'trainers',
  'user_health_details',
  'password_reset_tokens',
  'refresh_tokens',
  'accounts',
  'addresses',
  'socials_networks',
  'nutritionists',
  'diet_item_substitutes',
  'diet_food_items',
  'diet_meal_options',
  'diet_meals',
  'diet_meal_logs',
  'diet_swap_logs',
  'water_logs',
  'diet_protocols',
  'patient_metabolic_profiles',
  'patient_invites',
  'nutritionist_patients',
  'foods',
  'food_groups',
  'user_preferences',
  'subscription_payments',
  'student_subscriptions',
  'subscription_plans',
  'trainer_briefing_snapshots',
  'platform_subscription_payments',
  'platform_subscriptions',
  'ai_usage_events',
  'tutorials',
  'users',
  'user_waitlist',
  // Not FK-linked to users, so TRUNCATE ... CASCADE on users does not reach them.
  'pending_signup_codes',
  'pending_signups',
  'existing_account_notices',
];

let cascadeTablesPromise;

/**
 * Clean all test data from the database. Use this in beforeEach hooks to ensure
 * test isolation.
 *
 * Same end state as `TRUNCATE <TABLES> RESTART IDENTITY CASCADE`, but only the
 * tables that actually hold rows are truncated: TRUNCATE costs ~1ms per table
 * even when empty, and most tests touch a handful of the ~60 tables.
 */
export async function cleanDatabase() {
  // why: system advanced techniques come from a data migration and TRUNCATE ... CASCADE on `trainers` empties advanced_techniques too; snapshot and restore them.
  const systemTechniques = await readSystemAdvancedTechniques();

  const tables = await findNonEmptyTables(await getCascadeTables());
  if (tables.length > 0) {
    await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map(quoteIdent).join(', ')} RESTART IDENTITY CASCADE`);
  }

  if (systemTechniques.length > 0) {
    await prisma.advancedTechnique.createMany({ data: systemTechniques, skipDuplicates: true });
  }
}

// TABLES plus every table that references them through a foreign key, transitively — what TRUNCATE ... CASCADE reaches. Computed once per worker.
function getCascadeTables() {
  cascadeTablesPromise ??= prisma
    .$queryRawUnsafe(
      `WITH RECURSIVE reached(oid) AS (
         SELECT c.oid FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = current_schema() AND c.relname IN (${TABLES.map(quoteLiteral).join(', ')})
         UNION
         SELECT con.conrelid FROM pg_constraint con
         JOIN reached ON con.confrelid = reached.oid
         WHERE con.contype = 'f'
       )
       SELECT relname FROM pg_class WHERE oid IN (SELECT oid FROM reached)`,
    )
    .then((rows) => rows.map((row) => row.relname));
  return cascadeTablesPromise;
}

// Returns the subset of `tables` that has at least one row, in a single round trip.
async function findNonEmptyTables(tables) {
  const probes = tables.map(
    (table) => `SELECT ${quoteLiteral(table)} AS relname WHERE EXISTS (SELECT 1 FROM ${quoteIdent(table)})`,
  );
  const rows = await prisma.$queryRawUnsafe(probes.join(' UNION ALL '));
  return rows.map((row) => row.relname);
}

// Reads the system (trainerId null) advanced techniques; [] before the model exists.
async function readSystemAdvancedTechniques() {
  if (!prisma.advancedTechnique) return [];
  return prisma.advancedTechnique.findMany({ where: { trainerId: null } });
}

// Quotes a table name as a SQL identifier.
function quoteIdent(name) {
  return `"${name.replaceAll('"', '""')}"`;
}

// Quotes a value as a SQL string literal.
function quoteLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}
