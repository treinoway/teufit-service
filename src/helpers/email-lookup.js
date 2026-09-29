/**
 * Case-insensitive user lookup by email, backed by the `users_email_lower_idx`
 * expression index (`lower(email)`, migration 20260928120000).
 *
 * Prisma's `{ email: { equals, mode: 'insensitive' } }` compiles to
 * `email ILIKE $1`, which has two problems:
 * - `_` and `%` in the email are treated as wildcards, so e.g. an invite for
 *   `joao_silva@gmail.com` can wrongly match an existing user
 *   `joao.silva@gmail.com`.
 * - It cannot use a btree/expression index, forcing a sequential scan.
 *
 * This helper issues a parameterized `lower(email) = lower($1)` query
 * instead — exact equality, no wildcard semantics, and index-backed.
 *
 * Returns only the matching row's `id`. Callers that need the full user
 * record re-fetch it with `prisma.user.findUnique({ where: { id } })` so the
 * shape stays exactly what Prisma normally returns (correct types, camelCase
 * fields) instead of hand-mapping raw SQL columns.
 *
 * @param {import('@prisma/client').PrismaClient | import('@prisma/client').Prisma.TransactionClient} prismaClient
 * @param {string|null|undefined} email
 * @returns {Promise<string|null>} matching user id, or null
 */
export async function findUserIdByEmailCaseInsensitive(prismaClient, email) {
  if (!email || typeof email !== 'string') return null;

  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) return null;

  const rows = await prismaClient.$queryRaw`
    SELECT id FROM users WHERE lower(email) = ${normalizedEmail} LIMIT 1
  `;

  return rows[0]?.id ?? null;
}
