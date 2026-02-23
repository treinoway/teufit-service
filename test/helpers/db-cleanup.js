import { prisma } from '../../src/db.js';

/**
 * Clean all test data from database using TRUNCATE CASCADE.
 * This is much faster and safer than deleteMany() as it:
 * - Ignores foreign key constraints with CASCADE
 * - Resets auto-increment counters with RESTART IDENTITY
 * - Is atomic and doesn't require specific ordering
 * 
 * Use this in beforeEach hooks to ensure test isolation.
 */
export async function cleanDatabase() {
  const tables = [
    'training_schedules',
    'trainings',
    'training_protocols',
    'training_templates',
    'training_protocol_templates',
    'trainer_students',
    'trainers',
    'user_health_details',
    'password_reset_tokens',
    'refresh_tokens',
    'accounts',
    'addresses',
    'socials_networks',
    'nutritionists',
    'user_preferences',
    'users',
    'user_waitlist',
  ];

  // TRUNCATE with CASCADE will automatically handle foreign key constraints
  // RESTART IDENTITY resets sequences (auto-increment counters)
  await prisma.$executeRawUnsafe(
    `TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`
  );
}
