/**
 * Deadlock retry wrapper for Prisma transactions.
 *
 * When Postgres detects a deadlock (40P01) or serialization failure (40001),
 * it rolls back the victim transaction entirely. Re-invoking `fn()` — which
 * re-opens a fresh `prisma.$transaction(...)` — is therefore safe: the previous
 * attempt left no partial state behind.
 *
 * Non-deadlock errors (AppError, validation, 404, etc.) are rethrown immediately
 * on the first attempt; only retryable database errors trigger a retry loop.
 *
 * @param {() => Promise<any>} fn - Async factory that opens and executes a transaction.
 * @param {{ maxRetries?: number, baseDelayMs?: number }} [opts]
 * @returns {Promise<any>} Resolves with the return value of `fn` on success.
 */
export async function withDeadlockRetry(fn, { maxRetries = 3, baseDelayMs = 25 } = {}) {
  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;

      if (!isDeadlockError(err) || attempt >= maxRetries) {
        throw err;
      }

      const delay = baseDelayMs * (2 ** (attempt - 1)) + Math.random() * baseDelayMs;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Returns true when the error represents a deadlock or serialization failure
 * that Postgres has already rolled back, making a retry safe.
 *
 * Covers:
 *  - Prisma P2034 (write conflict / deadlock)
 *  - Postgres 40P01 (deadlock_detected)
 *  - Postgres 40001 (serialization_failure)
 *  - Same codes nested on err.meta?.code or err.cause?.code
 *  - Fallback: message substring match
 */
function isDeadlockError(err) {
  const retryableCodes = new Set(['P2034', '40P01', '40001']);

  if (retryableCodes.has(err?.code)) return true;
  if (retryableCodes.has(err?.meta?.code)) return true;
  if (retryableCodes.has(err?.cause?.code)) return true;

  if (err?.message && /deadlock detected|could not serialize/i.test(err.message)) return true;

  return false;
}
