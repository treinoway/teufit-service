import 'dotenv/config';
import { authenticateWithGoogle, ensureProfileForUser, signupWithEmailPassword, loginWithEmailPassword } from '../../src/services/authService.js';
import { Roles, roleValues } from '../../src/constants/roles.js';
import { verifyGoogleIdToken } from '../../src/services/googleIdTokenService.js';
import { issueAccessToken, issueRefreshToken, verifyRefreshToken, revokeRefreshToken } from '../../src/services/tokenService.js';
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

  // Email/password signup (session-based)
  fastify.post('/auth/signup', async (request, reply) => {
    try {
      const body = request.body ?? {};
      const email = body.email;
      const password = body.password;

      const user = await signupWithEmailPassword({ email, password, role: Roles.TRAINER });

      // Create trainer row (pending onboarding) so the rest of the app can rely on it.
      await ensureProfileForUser({
        userId: user.id,
        role: Roles.TRAINER,
        profileSeed: {
          name: typeof email === 'string' ? email.split('@')[0] : 'New Trainer',
        },
      });

      request.session.set('user', {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
        status: user.status,
      });

      return reply.status(201).send({ user });
    } catch (error) {
      if (error?.code === 'EMAIL_REQUIRED' || error?.code === 'WEAK_PASSWORD' || error?.code === 'INVALID_ROLE') {
        return reply.status(400).send({ error: error.code, message: error.message });
      }
      if (error?.code === 'EMAIL_IN_USE') {
        return reply.status(409).send({ error: 'EMAIL_IN_USE' });
      }
      if (error?.code === 'USER_DELETED') {
        return reply.status(403).send({ error: 'Account deactivated' });
      }

      fastify.log.error(error);
      return reply.status(500).send({ error: 'Signup failed' });
    }
  });

  // Email/password login (session-based)
  fastify.post('/auth/login', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '1 minute'
      }
    }
  }, async (request, reply) => {
    try {
      const body = request.body ?? {};
      const email = body.email;
      const password = body.password;

      const user = await loginWithEmailPassword({ email, password });

      request.session.set('user', {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
        status: user.status,
      });

      const token = issueAccessToken({ fastify, user });
      const refreshTokenData = await issueRefreshToken({ user });

      return reply.send({
        user,
        ...token,
        refreshToken: refreshTokenData.refreshToken,
      });
    } catch (error) {
      if (error?.code === 'EMAIL_REQUIRED' || error?.code === 'PASSWORD_REQUIRED') {
        return reply.status(400).send({ error: error.code, message: error.message });
      }
      if (error?.code === 'INVALID_CREDENTIALS') {
        return reply.status(401).send({ error: 'INVALID_CREDENTIALS' });
      }
      if (error?.code === 'USER_DELETED') {
        return reply.status(403).send({ error: 'Account deactivated' });
      }
      if (error?.code === 'PASSWORD_NOT_SET') {
        return reply.status(409).send({ error: 'PASSWORD_NOT_SET' });
      }

      fastify.log.error(error);
      return reply.status(500).send({ error: 'Login failed' });
    }
  });

  fastify.get('/auth/trainer/google', async (request, reply) => {
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
        return reply.status(403).send({
          error: 'Missing role',
          message: `Missing role for OAuth flow.`,
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


      request.session.set('user', {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
      });

      // Browser flow: redirect after login to your frontend.
      // The frontend can then call backend endpoints like GET /me using the session cookie.
      const frontendRedirectUrl = process.env.FRONTEND_REDIRECT_URL || process.env.FRONTEND_URL;
      if (!frontendRedirectUrl) {
        return reply
          .status(500)
          .send({ error: 'Missing FRONTEND_REDIRECT_URL (or FRONTEND_URL) env var' });
      }

      return reply.redirect(frontendRedirectUrl);
    } catch (error) {
      if (error?.code === 'USER_DELETED') {
        return reply.status(403).send({ error: 'Account deactivated' });
      }
      if (error?.code === 'ROLE_REQUIRED') {
        return reply.status(400).send({
          error: 'Missing role',
          message: `Start auth using /auth/trainer/google.`,
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

  // Refresh Token Route
  fastify.post('/auth/refresh', async (request, reply) => {
    const { refreshToken } = request.body || {};

    if (!refreshToken) {
      return reply.status(400).send({ error: 'Missing refresh token' });
    }

    try {
      const user = await verifyRefreshToken(refreshToken);
      const token = issueAccessToken({ fastify, user });

      // Optionally rotate refresh token here (issue new one, revoke old one)
      // For simplicity, we keep the same refresh token until it expires.

      return reply.send({
        ...token,
        // refreshToken // If rotating, return new one here
      });
    } catch (error) {
      return reply.status(401).send({ error: 'Invalid or expired refresh token' });
    }
  });

  // Logout route
  fastify.post('/auth/logout', async (request, reply) => {
    // Session logout
    if (typeof request.session.destroy === 'function') {
      await request.session.destroy();
    } else {
      unsetSessionKey(request.session, 'user');
      unsetSessionKey(request.session, 'oauthRole');
    }

    // Refresh Token revocation
    const { refreshToken } = request.body || {};
    if (refreshToken) {
      try {
        await revokeRefreshToken(refreshToken);
      } catch (e) {
        // Ignore errors during logout (e.g. token already invalid)
        fastify.log.warn(`Logout revocation failed: ${e.message}`);
      }
    }

    return reply.send({ message: 'Logged out successfully' });
  });


}
