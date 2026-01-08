import 'dotenv/config';
import { authenticateWithGoogle, ensureProfileForUser } from '../../src/services/authService.js';
import { Roles, roleValues } from '../../src/constants/roles.js';
import { verifyGoogleIdToken } from '../../src/services/googleIdTokenService.js';
import { issueAccessToken } from '../../src/services/tokenService.js';
import { findOrCreateUserFromOAuth } from '../../src/helpers/auth.js';
import fastifyOauth2 from '@fastify/oauth2'


export async function authRoutes(fastify) {

    // Configure Google OAuth2 plugin.
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


  const unsetSessionKey = (session, key) => {
    if (!session) return;
    if (typeof session.unset === 'function') return session.unset(key);
    // fastify-session supports get/set; setting undefined/null removes the key semantically for our use.
    if (typeof session.set === 'function') return session.set(key, undefined);
  };

   fastify.get('/auth/trainer/google', async (request, reply) => {
    // Routing/session glue (not business logic): mark this OAuth run as a trainer signup.
    request.session.set('oauthRole', Roles.TRAINER);
    return reply.redirect('/auth/google');
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
          message: `Start auth using /auth/google/start?role=${Roles.TRAINER}.`,
        });
      }

      const { user, googleUser } = await authenticateWithGoogle({ fastify, request });

      await ensureProfileForUser({
        userId: user.id,
        role: desiredRole,
        profileSeed: {
          name: googleUser?.name,
          givenName: googleUser?.given_name,
          familyName: googleUser?.family_name,
          avatar: googleUser?.picture
        },
      });
      
  unsetSessionKey(request.session, 'oauthRole');

      // Store user in session (cookie)
      request.session.set('user', {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
      });

      // Browser flow: redirect after login
      return reply.status(200).send({UserId: user.id})
    } catch (error) {
      if (error?.code === 'USER_DELETED') {
        return reply.status(403).send({ error: 'Account deactivated' });
      }
      if (error?.code === 'ROLE_REQUIRED') {
        return reply.status(400).send({
          error: 'Missing role',
          message: `Start auth using /auth/google/start?role=${Roles.TRAINER}.`,
        });
      }
      fastify.log.error(error);
      return reply.status(500).send({ error: 'Authentication failed' });
    }
  });

  // // Mobile-native Google auth (no redirects):
  // // Mobile app performs Google Sign-In and sends the ID token here.
  // // Returns a Bearer access token (JWT) to be used in Authorization header.
  // fastify.post('/auth/mobile/google', async (request, reply) => {
  //   try {
  //     const body = request.body ?? {};
  //     const idToken = body.idToken ?? body.id_token;

  //     const google = await verifyGoogleIdToken({
  //       idToken,
  //       audience: process.env.GOOGLE_OAUTH_CLIENT_ID,
  //     });

  //     if (!google.email) {
  //       return reply.status(400).send({ error: 'Google account email not available' });
  //     }

  //     // For now, mobile auth only creates/logs in trainers.
  //     const role = Roles.TRAINER;

  //     const user = await findOrCreateUserFromOAuth({
  //       provider: 'google',
  //       providerId: google.subject,
  //       email: google.email,
  //       name: google.name ?? google.email,
  //       avatar: google.picture,
  //       accessToken: null,
  //       refreshToken: null,
  //       expiresAt: null,
  //       role,
  //     });

  //     await ensureProfileForUser({
  //       userId: user.id,
  //       role,
  //       profileSeed: {
  //         name: google.name,
  //       },
  //     });

  //     const token = issueAccessToken({ fastify, user });
  //     return reply.send({
  //       ...token,
  //       user: {
  //         id: user.id,
  //         email: user.email,
  //         role: user.role,
  //         status: user.status,
  //       },
  //     });
  //   } catch (error) {
  //     if (error?.code === 'USER_DELETED') {
  //       return reply.status(403).send({ error: 'Account deactivated' });
  //     }
  //     if (error?.code === 'ID_TOKEN_REQUIRED') {
  //       return reply.status(400).send({ error: 'Missing idToken' });
  //     }
  //     if (error?.code === 'ERR_JWT_EXPIRED') {
  //       return reply.status(401).send({ error: 'Google token expired' });
  //     }
  //     if (error?.code === 'ERR_JWS_INVALID' || error?.code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
  //       return reply.status(401).send({ error: 'Invalid Google token' });
  //     }

  //     fastify.log.error(error);
  //     return reply.status(500).send({ error: 'Authentication failed' });
  //   }
  // });

  // Logout route
  fastify.get('/auth/logout', async (request, reply) => {
    if (typeof request.session.destroy === 'function') {
      await request.session.destroy();
    } else {
      // fallback: clear known keys
      unsetSessionKey(request.session, 'user');
      unsetSessionKey(request.session, 'oauthRole');
    }
    return reply.send({ message: 'Logged out successfully' });
  });


}
