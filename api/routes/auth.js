import 'dotenv/config';
import { prisma } from '../../src/db.js';
import { findOrCreateUserFromOAuth } from '../../src/helpers/auth.js';

export async function authRoutes(fastify, options) {
  // Configure Google OAuth2
  fastify.register(import('@fastify/oauth2'), {
    name: 'googleOAuth2',
    credentials: {
      client: {
        id: process.env.GOOGLE_OAUTH_CLIENT_ID,
        secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      },
      auth: import('@fastify/oauth2').then(m => m.GOOGLE_CONFIGURATION),
    },
    startRedirectPath: '/auth/google',
    callbackUri: process.env.GOOGLE_OAUTH_CALLBACK_URL,
    scope: ['profile', 'email'],
  });

  // Google OAuth callback route
  fastify.get('/auth/google/callback', async (request, reply) => {
    try {
      // Exchange code for token
      const { token } = await fastify.googleOAuth2.getAccessTokenFromAuthorizationCodeFlow(request);

      // Get user info from Google
      const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: {
          Authorization: `Bearer ${token.access_token}`,
        },
      });

      const googleUser = await userInfoResponse.json();

      // Find or create user using helper function
      const user = await findOrCreateUserFromOAuth({
        provider: 'google',
        providerId: googleUser.id,
        email: googleUser.email,
        name: googleUser.name,
        avatar: googleUser.picture,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: token.expires_at,
      });

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
    const fullUser = await prisma.user.findUnique({
      where: { id: user.id },
      include: {
        accounts: {
          select: {
            provider: true,
            createdAt: true,
          }
        }
      }
    });

    return reply.send({ user: fullUser });
  });
}
