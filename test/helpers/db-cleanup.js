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
    'diet_food_items',
    'diet_meals',
    'diet_protocols',
    'diet_template_food_items',
    'diet_template_meals',
    'diet_protocol_templates',
    'patient_metabolic_profiles',
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
    'users',
    'user_waitlist',
  ];

  // TRUNCATE with CASCADE will automatically handle foreign key constraints
  // RESTART IDENTITY resets sequences (auto-increment counters)
  await prisma.$executeRawUnsafe(
    `TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`
  );
}
