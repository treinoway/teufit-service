import 'dotenv/config';
import { authenticateWithGoogle, ensureProfileForUser, getCurrentUserWithAccounts } from '../../src/services/authService.js';
import { Roles, roleValues } from '../../src/constants/roles.js';
import fastifyOauth2 from '@fastify/oauth2'


export async function authRoutes(fastify) {
  // Choose account type before starting OAuth.
  // Usage: GET /auth/google/start?role=student|trainer
  // We store the choice in the session so it survives the OAuth redirect.
  fastify.get('/auth/google/start', async (request, reply) => {
    const { role } = request.query ?? {};
    if (roleValues.includes(role)) {
      request.session.set('oauthRole', role);
    } else if (role != null) {
      return reply.status(400).send({ error: `Invalid role. Use ${Roles.STUDENT} or ${Roles.TRAINER}.` });
    }

    // Redirect into the oauth2 plugin redirect path.
    return reply.redirect('/auth/google');
  });

  // Configure Google OAuth2
  fastify.register(fastifyOauth2, {
    name: 'googleOAuth2',
    credentials: {
      client: {
        id: process.env.GOOGLE_OAUTH_CLIENT_ID,
        secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      },
      auth: fastifyOauth2.GOOGLE_CONFIGURATION,
    },
    startRedirectPath: '/auth/google',
    callbackUri: process.env.GOOGLE_OAUTH_CALLBACK_URL,
    scope: ['profile', 'email'],
  });

  // Google OAuth callback route
  fastify.get('/auth/google/callback', async (request, reply) => {
    try {
      // Require role selection before OAuth.
      // We can't rely on query params on the callback, so we enforce the session value.
      const desiredRole = request.session.get('oauthRole');
      if (!roleValues.includes(desiredRole)) {
        return reply.status(400).send({
          error: 'Missing role',
          message: `Start auth using /auth/google/start?role=${Roles.STUDENT} or ${Roles.TRAINER}.`,
        });
      }

      const { user } = await authenticateWithGoogle({ fastify, request });

      await ensureProfileForUser({ userId: user.id, role: desiredRole });
      request.session.delete('oauthRole');

      // Store user in session (cookie)
      request.session.set('user', {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
      });

      // Redirect to dashboard or home
      return reply.redirect('/dashboard');
    } catch (error) {
      if (error?.code === 'USER_DELETED') {
        return reply.status(403).send({ error: 'Account deactivated' });
      }
      if (error?.code === 'ROLE_REQUIRED') {
        return reply.status(400).send({
          error: 'Missing role',
          message: `Start auth using /auth/google/start?role=${Roles.STUDENT} or ${Roles.TRAINER}.`,
        });
      }
      fastify.log.error(error);
      return reply.status(500).send({ error: 'Authentication failed' });
    }
  });

  // Logout route
  fastify.get('/auth/logout', async (request, reply) => {
    request.session.delete();
    return reply.send({ message: 'Logged out successfully' });
  });

  // Get current user
  fastify.get('/auth/me', async (request, reply) => {
    const user = request.session.get('user');
    
    if (!user) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    // Get user with connected accounts
    const fullUser = await getCurrentUserWithAccounts(user.id);

    return reply.send({ user: fullUser });
  });
}
