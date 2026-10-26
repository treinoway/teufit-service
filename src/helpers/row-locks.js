/**
 * Shared row-level lock helpers for deadlock prevention.
 *
 * Each helper acquires an exclusive row lock on the named table using
 * a FOR UPDATE select. The table name is hardcoded in the tagged template
 * literal — it is never interpolated — so there is no SQL-injection risk.
 * The id is passed as a parameter and handled safely by Prisma's $queryRaw.
 *
 * Usage contract: call the appropriate lock helper as the FIRST statement
 * inside every write transaction that touches the parent row. This forces
 * all concurrent writers to queue on the same lock, eliminating the
 * non-deterministic multi-lock ordering that produces deadlocks.
 */

/**
 * Acquire an exclusive row-level lock on the `trainings` table row.
 * Call FIRST inside any transaction that writes exercises for this training.
 *
 * @param {object} tx - Prisma interactive transaction client
 * @param {string} id - Training UUID
 */
export async function lockTrainingForUpdate(tx, id) {
  await tx.$queryRaw`SELECT id FROM trainings WHERE id = ${id}::uuid FOR UPDATE`;
}

/**
 * Acquire an exclusive row-level lock on the `workout_sessions` table row.
 * Call FIRST inside any transaction that writes exercise logs for this session.
 *
 * @param {object} tx - Prisma interactive transaction client
 * @param {string} id - WorkoutSession UUID
 */
export async function lockWorkoutSessionForUpdate(tx, id) {
  await tx.$queryRaw`SELECT id FROM workout_sessions WHERE id = ${id}::uuid FOR UPDATE`;
}

/**
 * Acquire an exclusive row-level lock on the `anamneses` table row.
 * Call FIRST inside any transaction that writes sections for this anamnesis.
 *
 * @param {object} tx - Prisma interactive transaction client
 * @param {string} id - Anamnesis UUID
 */
export async function lockAnamnesisForUpdate(tx, id) {
  await tx.$queryRaw`SELECT id FROM anamneses WHERE id = ${id}::uuid FOR UPDATE`;
}

/**
 * Acquire an exclusive row-level lock on the `anamnesis_responses` table row.
 * Call FIRST (after resolving the row id) inside any transaction that mutates the
 * answers of this response, then re-read any state that guards the write
 * (e.g. `submittedAt`) AFTER the lock is held.
 *
 * @param {object} tx - Prisma interactive transaction client
 * @param {string} id - AnamnesisResponse UUID
 */
export async function lockAnamnesisResponseForUpdate(tx, id) {
  await tx.$queryRaw`SELECT id FROM anamnesis_responses WHERE id = ${id}::uuid FOR UPDATE`;
}

/**
 * Acquire an exclusive row-level lock on the `training_templates` row (call FIRST when appending junction rows).
 *
 * @param {object} tx - Prisma interactive transaction client
 * @param {string} id - TrainingTemplate UUID
 */
export async function lockTrainingTemplateForUpdate(tx, id) {
  await tx.$queryRaw`SELECT id FROM training_templates WHERE id = ${id}::uuid FOR UPDATE`;
}
