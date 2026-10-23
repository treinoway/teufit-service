// Step 2 of the public exercise catalog: reviewed JSON -> public exercise_templates.
//
// Dry-run by default: prints what would change and writes nothing.
// Writing needs --apply AND --confirm-host set to the database host in
// DATABASE_URL, so a run can never hit a database you did not name explicitly.
//
// Usage:
//   DATABASE_URL=<staging url> npm run catalog:import -- --owner-email conta@teufit.com
//   DATABASE_URL=<staging url> npm run catalog:import -- --owner-email conta@teufit.com \
//     --apply --confirm-host <host shown by the dry-run>
//
// The owner must be an existing user with a trainer profile. Public templates are
// listed with the owner's name in the app, so use a platform account.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { importPublicExerciseCatalog } from './lib/public-exercise-catalog.js';

const DEFAULT_CATALOG_PATH = 'prisma/seeds/data/teufit-exercise-catalog.json';

const { values: args } = parseArgs({
  options: {
    catalog: { type: 'string', default: DEFAULT_CATALOG_PATH },
    'owner-email': { type: 'string' },
    apply: { type: 'boolean', default: false },
    'confirm-host': { type: 'string' },
  },
});

function databaseHost() {
  try {
    return new URL(process.env.DATABASE_URL).hostname;
  } catch {
    throw new Error('DATABASE_URL is missing or invalid.');
  }
}

function printList(title, items, format = (item) => `${item.name} (${item.type})`) {
  if (items.length === 0) return;
  console.log(`\n${title}: ${items.length}`);
  for (const item of items) console.log(`  - ${format(item)}`);
}

async function main() {
  if (!args['owner-email']) throw new Error('--owner-email is required.');

  const host = databaseHost();
  if (args.apply && args['confirm-host'] !== host) {
    throw new Error(
      `Refusing to write: --confirm-host must equal the DATABASE_URL host ("${host}").`,
    );
  }

  const catalog = JSON.parse(readFileSync(args.catalog, 'utf8'));
  console.log(`Database host: ${host}`);
  console.log(`Mode: ${args.apply ? 'APPLY (writing)' : 'dry-run (no writes)'}`);
  console.log(`Catalog: ${args.catalog} (${catalog.entries?.length ?? 0} entries)`);

  // Imported here so a missing/invalid DATABASE_URL fails with the message above.
  const { prisma } = await import('../src/db.js');
  try {
    const report = await importPublicExerciseCatalog(prisma, {
      catalog,
      ownerEmail: args['owner-email'],
      apply: args.apply,
    });

    console.log(`Owner trainer: ${report.trainerId}`);
    printList(args.apply ? 'Created' : 'Would create', report.create);
    printList('Already present, untouched', report.existing);
    printList('Deleted in the app, kept deleted', report.deleted);
    printList('Duplicate inside the catalog, skipped', report.duplicateInCatalog);
    printList(
      'Owner already has this exercise, skipped',
      report.duplicateOfOwner,
      (item) => `${item.name} (${item.type}) -> ${item.existingTemplateId}`,
    );
    printList('Warnings', report.warnings, (warning) => warning);

    console.log(
      args.apply
        ? `\nDone: ${report.created} template(s) created.`
        : `\nDry-run only. Re-run with --apply --confirm-host ${host} to write.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
