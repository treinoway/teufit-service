import 'dotenv/config';
import { describe, it, expect } from 'vitest';
import { prisma } from '../../src/db.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

// Guard test for RFC 002 §5.6 / addendum v3.1: the two partial unique indexes and
// the CHECK constraint on exercise_categories are NOT representable in
// schema.prisma (WHERE on @@unique, conditional CHECK), so they live only in
// prisma/migrations/<ts>_add_exercise_categories/migration.sql as hand-added raw
// SQL. `prisma migrate dev` diffs the migration history against schema.prisma —
// an object it doesn't "see" there reads as something to remove, and it has
// silently dropped indexes like this before in this repo (see
// 20260617232122_library_search_indexes -> 20260617235213_add_pagination_on_library,
// 31 minutes apart). If that happens here, nothing errors: the app just starts
// accepting duplicate categories or a trainer_id/isPublic mismatch. This test is
// the only mitigation that doesn't depend on a human noticing a DropIndex/
// DropConstraint in a future migration diff.
e2eDescribe('e2e: exercise_categories indexes and constraint (drift guard)', () => {
  it('keeps the private-scope partial unique index intact', async () => {
    const indexes = await prisma.$queryRaw`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'exercise_categories'
        AND indexname = 'exercise_categories_private_scope_name_uniq'
    `;

    expect(
      indexes,
      'exercise_categories_private_scope_name_uniq is missing — likely dropped by ' +
        'a prisma migrate dev diff that does not know about this hand-added index. ' +
        'See RFC 002 §5.6.',
    ).toHaveLength(1);
    expect(indexes[0].indexdef).toContain('UNIQUE INDEX');
    expect(indexes[0].indexdef).toContain('(trainer_id, name_normalized)');
    expect(indexes[0].indexdef).toContain('is_public = false');
    expect(indexes[0].indexdef).toContain('deleted_at IS NULL');
  });

  it('keeps the public-scope partial unique index intact', async () => {
    const indexes = await prisma.$queryRaw`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'exercise_categories'
        AND indexname = 'exercise_categories_public_name_uniq'
    `;

    expect(
      indexes,
      'exercise_categories_public_name_uniq is missing — likely dropped by a ' +
        'prisma migrate dev diff that does not know about this hand-added index. ' +
        'See RFC 002 §5.6.',
    ).toHaveLength(1);
    expect(indexes[0].indexdef).toContain('UNIQUE INDEX');
    expect(indexes[0].indexdef).toContain('(name_normalized)');
    expect(indexes[0].indexdef).toContain('is_public = true');
    expect(indexes[0].indexdef).toContain('deleted_at IS NULL');
  });

  it('keeps the is_public/trainer_id consistency CHECK constraint intact', async () => {
    const constraints = await prisma.$queryRaw`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'exercise_categories'::regclass
        AND conname = 'exercise_categories_public_ownership_chk'
    `;

    expect(
      constraints,
      'exercise_categories_public_ownership_chk is missing — likely dropped by a ' +
        'prisma migrate dev diff that does not know about this hand-added ' +
        'constraint. See RFC 002 §5.6 / addendum v3.1.',
    ).toHaveLength(1);
    expect(constraints[0].definition).toContain('is_public = true');
    expect(constraints[0].definition).toContain('trainer_id IS NULL');
    expect(constraints[0].definition).toContain('is_public = false');
    expect(constraints[0].definition).toContain('trainer_id IS NOT NULL');
  });

  it('rejects a second public category with the same normalized name', async () => {
    const nameNormalized = `guard-test-public-${Date.now()}`;

    const created = await prisma.exerciseCategory.create({
      data: { isPublic: true, trainerId: null, name: 'Guard test', nameNormalized },
    });

    try {
      await expect(
        prisma.exerciseCategory.create({
          data: { isPublic: true, trainerId: null, name: 'Guard test', nameNormalized },
        }),
      ).rejects.toThrow();
    } finally {
      // Public rows aren't touched by cleanDatabase()'s trainer-cascade truncate
      // (trainer_id is NULL by design) — delete explicitly so repeated runs don't
      // accumulate rows in a shared dev/test database.
      await prisma.exerciseCategory.delete({ where: { id: created.id } });
    }
  });

  it('rejects a row where is_public and trainer_id disagree', async () => {
    const trainer = await prisma.trainer.findFirst({ select: { id: true } });
    if (!trainer) {
      // No trainer fixture in this environment — the private-scope half of the
      // CHECK (is_public = false requires trainer_id NOT NULL) is still provable.
      await expect(
        prisma.$executeRaw`
          INSERT INTO exercise_categories (id, is_public, trainer_id, name, name_normalized)
          VALUES (gen_random_uuid(), false, NULL, 'Bad', 'bad-consistency-guard')
        `,
      ).rejects.toThrow();
      return;
    }

    await expect(
      prisma.$executeRaw`
        INSERT INTO exercise_categories (id, is_public, trainer_id, name, name_normalized)
        VALUES (gen_random_uuid(), true, ${trainer.id}::uuid, 'Bad', 'bad-consistency-guard')
      `,
    ).rejects.toThrow();
  });
});
