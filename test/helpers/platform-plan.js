import { prisma } from '../../src/db.js';

/**
 * Provision a PlatformSubscription for a trainer in E2E tests.
 *
 * Trainers created via POST /auth/signup + PATCH /become-trainer have no
 * PlatformSubscription row, so `getTrainerPlan` (src/services/platform-plan-service.js)
 * defaults them to the FREE tier (studentCap: 3, no AI, no branding, no championships —
 * see src/constants/platform-plan.js). Tests that exercise plan-gated routes need an
 * explicit subscription set up first.
 *
 * Defaults to DIAMOND, which unlocks every gate (unlimited students/AI, branding,
 * championships) — the common case for tests that aren't specifically about plan limits.
 * Pass a lower tier explicitly when the test's intent is to exercise a gate/limit.
 *
 * @param {string} trainerId - Trainer.id (NOT User.id) — the value returned as
 *   `trainerId` by the `createTrainerWithToken()` helpers used across E2E files.
 * @param {'FREE'|'PRO'|'PLATINUM'|'DIAMOND'|'BETA'} [tier='DIAMOND']
 * @returns {Promise<object>} the upserted PlatformSubscription row
 */
export async function provisionTrainerPlan(trainerId, tier = 'DIAMOND') {
  return prisma.platformSubscription.upsert({
    where: { trainerId },
    create: { trainerId, tier, status: 'ACTIVE' },
    update: { tier, status: 'ACTIVE' },
  });
}
