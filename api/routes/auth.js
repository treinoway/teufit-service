import fastifyOauth2 from '@fastify/oauth2';
import 'dotenv/config';
import { Roles } from '../../src/constants/roles.js';
import { findOrCreateUserFromOAuth } from '../../src/helpers/auth.js';
import {
  ensureProfileForUser,
  loginWithEmailPasswordStateless,
  requestPasswordReset,
  resetPasswordWithToken,
  signupWithEmailPasswordStateless,
} from '../../src/services/auth-service.js';
import { verifyGoogleIdToken } from '../../src/services/google-id-token-service.js';
import {
  issueAccessToken,
  issueRefreshToken,
  revokeRefreshToken,
  verifyRefreshToken
} from '../../src/services/token-service.js';
import emailHandler from '../../src/config/email-handler.js';
import {
  signupSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  googleStartSchema,
  googleCallbackSchema,
  googleMobileSchema,
  refreshSchema,
  logoutSchema,
} from '../schemas/auth-route.schema.js';

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

  // Email/password signup (stateless)
  fastify.post(
    '/auth/signup',
    {
      schema: signupSchema,
    },
    async (request, reply) => {
      try {
        const body = request.body ?? {};
        const email = body.email;
        const password = body.password;

        const { userId, accessToken, refreshToken } = await signupWithEmailPasswordStateless({
          fastify,
          email,
          password,
          roles: [Roles.STUDENT],
        });

        return reply.status(201).send({
          user: { id: userId },
          token: { accessToken },
          refreshToken,
        });
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
        if (error?.code === 'JWT_NOT_CONFIGURED') {
          return reply.status(500).send({ error: 'JWT_NOT_CONFIGURED', message: error.message });
        }

        fastify.log.error(error);
        return reply.status(500).send({ error: 'Signup failed' });
      }
    },
  );

  fastify.post(
    '/auth/login',
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
        },
      },
      schema: loginSchema,
    },
    async (request, reply) => {
      try {
        const body = request.body ?? {};
        const email = body.email;
        const password = body.password;

        const { userId, accessToken, refreshToken } = await loginWithEmailPasswordStateless({
          fastify,
          email,
          password,
        });

        return reply.send({
          user: { id: userId },
          token: { accessToken },
          refreshToken,
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
        if (error?.code === 'JWT_NOT_CONFIGURED') {
          return reply.status(500).send({ error: 'JWT_NOT_CONFIGURED', message: error.message });
        }

        fastify.log.error(error);
        return reply.status(500).send({ error: 'Login failed' });
      }
    },
  );

  // Request password reset (stateless)
  fastify.post(
    '/auth/forgot-password',
    {
      schema: forgotPasswordSchema,
    },
    async (request, reply) => {
      try {
        const body = request.body ?? {};
        const email = body.email;

        const { resetToken } = await requestPasswordReset({ email });

        const payload = {
          message: 'If an account exists for this email, a reset link has been sent.',
        };

        // In non-production, expose the token to simplify manual testing.
        if (process.env.NODE_ENV !== 'production' && resetToken) {
          payload.resetToken = resetToken;
        }

        return emailHandler.sendResetPasswordEmail({ to: email, token: resetToken })
          .then((test) =>{
            console.log(test);
            reply.send(payload);
          })
          .catch((emailErr) => {
            console.log(emailErr);
            fastify.log.error(`Failed to send password reset email to ${email}: ${emailErr.message}`);
            return reply.send(payload);
          }).finally((info, error) => {
            console.log(error);
          })
      } catch (error) {
        if (error?.code === 'EMAIL_REQUIRED') {
          return reply.status(400).send({ error: error.code, message: error.message });
        }

        fastify.log.error(error);
        return reply.status(500).send({ error: 'FORGOT_PASSWORD_FAILED', message: 'Failed to process password reset request' });
      }
    },
  );

  // Reset password with token (stateless)
  fastify.post(
    '/auth/reset-password',
    {
      schema: resetPasswordSchema,
    },
    async (request, reply) => {
      try {
        const body = request.body ?? {};
        const token = body.token;
        const password = body.password;

        const user = await resetPasswordWithToken({ token, password });

        const access = issueAccessToken({ fastify, user });
        const refresh = await issueRefreshToken({ user });

        return reply.send({
          user: { id: user.id },
          token: { accessToken: access.accessToken },
          refreshToken: refresh.refreshToken,
        });
      } catch (error) {
        if (error?.code === 'RESET_TOKEN_REQUIRED' || error?.code === 'WEAK_PASSWORD' || error?.code === 'INVALID_RESET_TOKEN' || error?.code === 'RESET_TOKEN_EXPIRED') {
          return reply.status(400).send({ error: error.code, message: error.message });
        }
        if (error?.code === 'USER_DELETED') {
          return reply.status(403).send({ error: 'Account deactivated' });
        }
        if (error?.code === 'JWT_NOT_CONFIGURED') {
          return reply.status(500).send({ error: 'JWT_NOT_CONFIGURED', message: error.message });
        }

        fastify.log.error(error);
        return reply.status(500).send({ error: 'RESET_PASSWORD_FAILED', message: 'Failed to reset password' });
      }
    },
  );

  // Start Google OAuth (always creates/logs in student users)
  fastify.get(
    '/auth/google/start',
    {
      schema: googleStartSchema,
    },
    async (request, reply) => {
      // No role selection; authenticateWithGoogle always uses Roles.STUDENT
      return reply.redirect('/auth/google');
    },
  );

  // Google OAuth callback route
  fastify.get(
    '/auth/google/callback',
    {
      schema: googleCallbackSchema,
    },
    async (request, reply) => {
      try {
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
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Authentication failed', message: error.message });
      }
    },
  );

  // Mobile-native Google auth (no redirects):
  // Mobile app performs Google Sign-In and sends the ID token here.
  // Returns a Bearer access token (JWT) to be used in Authorization header.
  fastify.post(
    '/auth/google/mobile',
    {
      schema: googleMobileSchema,
    },
    async (request, reply) => {
      try {
        const body = request.body ?? {};
        const idToken = body.idToken ?? body.id_token;

        if (!idToken) {
          return reply.status(400).send({ error: 'ID_TOKEN_REQUIRED', message: 'Missing idToken' });
        }

        const google = await verifyGoogleIdToken({
          idToken,
          audience: process.env.GOOGLE_OAUTH_CLIENT_ID,
        });

        

        if (!google.email) {
          return reply.status(400).send({ error: 'GOOGLE_EMAIL_REQUIRED', message: 'Google account email not available' });
        }

        // New users from Google are always Students
        const roles = [Roles.STUDENT];

        const user = await findOrCreateUserFromOAuth({
          provider: 'google',
          providerId: google.subject,
          email: google.email,
          name: google.name ?? google.email,
          avatar: google.picture,
          accessToken: null,
          refreshToken: null,
          expiresAt: null,
          roles,
        });

        // Ensure user has a profile based on their role
        await ensureProfileForUser({
          userId: user.id,
          role: Roles.STUDENT,
          profileSeed: {
            name: google.name,
          },
        });

        const token = issueAccessToken({ fastify, user });
        const refreshTokenData = await issueRefreshToken({ user });

        return reply.send({
          user: { id: user.id },
          token: { accessToken: token.accessToken },
          refreshToken: refreshTokenData.refreshToken,
        });
      } catch (error) {
        if (error?.code === 'USER_DELETED') {
          return reply.status(403).send({ error: 'Account deactivated' });
        }
        if (error?.code === 'ID_TOKEN_REQUIRED') {
          return reply.status(400).send({ error: 'Missing idToken' });
        }
        if (error?.code === 'ERR_JWT_EXPIRED') {
          return reply.status(401).send({ error: 'Google token expired' });
        }
        if (error?.code === 'ERR_JWS_INVALID' || error?.code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
          return reply.status(401).send({ error: 'Invalid Google token' });
        }

        fastify.log.error(error);
        return reply.status(500).send({ error: 'Authentication failed' });
      }
    },
  );

  // Refresh Token Route
  fastify.post(
    '/auth/refresh',
    {
      schema: refreshSchema,
    },
    async (request, reply) => {
      const { refreshToken } = request.body || {};

      if (!refreshToken) {
        return reply.status(400).send({ error: 'Missing refresh token' });
      }

      try {
        const user = await verifyRefreshToken(refreshToken);
        const token = issueAccessToken({ fastify, user });

        // Optionally rotate refresh token here (issue new one, revoke old one)
        // For simplicity, we keep the same refresh token until it expires.

        return reply.send({ token: { accessToken: token.accessToken } });
      } catch (error) {
        request.log.warn({ error }, 'Refresh token verification failed');
        return reply.status(401).send({ error: 'Invalid or expired refresh token' });
      }
    },
  );

  fastify.post(
    '/auth/logout',
    {
      schema: logoutSchema,
    },
    async (request, reply) => {
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
    },
  );
}
