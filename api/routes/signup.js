import { startTrainerGoogleSignup } from '../../src/services/signupService.js';

/**
 * Signup-focused routes (OAuth kickoffs, etc).
 */
export async function signupRoutes(fastify) {
  // Trainer signup flow:
  // 1) GET /signup/trainer/google  -> starts Google OAuth with role=trainer
  // 2) then /auth/google/callback detects oauthFlow and returns JSON
  fastify.get('/signup/trainer/google', async (request, reply) => {
    const { redirectTo } = startTrainerGoogleSignup({ request });
    return reply.redirect(redirectTo);
  });
}
