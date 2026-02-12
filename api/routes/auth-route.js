import fastifyOauth2 from '@fastify/oauth2';
import 'dotenv/config';
import { findOrCreateUserFromOAuth } from '../../src/helpers/auth.js';
import { authenticate } from '../middleware/auth.js';
import {
  addEmailToWaitlist,
  changePassword,
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
  rotateRefreshToken
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
  waitlistSchema,
  changePasswordSchema,
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
          roles: [],
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

  // Join waitlist
  fastify.post(
    '/auth/signup/waitlist',
    {
      config: {
        rateLimit: {
          max: 3,
          timeWindow: '1 hour',
        },
      },
      schema: waitlistSchema,
    },
    async (request, reply) => {
      try {
        const body = request.body ?? {};
        const email = body.email;

        const result = await addEmailToWaitlist({ email });

        return reply.status(201).send(result);
      } catch (error) {
        if (error?.code === 'EMAIL_REQUIRED') {
          return reply.status(400).send({ error: error.code, message: error.message });
        }
        if (error?.code === 'EMAIL_ALREADY_ON_WAITLIST') {
          return reply.status(409).send({ error: error.code, message: error.message });
        }

        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to join waitlist' });
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

        return emailHandler.sendResetPasswordEmail({ to: email, passwordToken: resetToken })
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
        const passwordConfirmation = body.passwordConfirmation;

        const user = await resetPasswordWithToken({ token, password, passwordConfirmation });

        const access = issueAccessToken({ fastify, user });
        const refresh = await issueRefreshToken({ user });

        return reply.send({
          user: { id: user.id },
          token: { accessToken: access.accessToken },
          refreshToken: refresh.refreshToken,
        });
      } catch (error) {
        if (error?.code === 'RESET_TOKEN_REQUIRED' || error?.code === 'WEAK_PASSWORD' || error?.code === 'INVALID_RESET_TOKEN' || error?.code === 'RESET_TOKEN_EXPIRED' || error?.code === 'PASSWORD_MISMATCH') {
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

  // Start Google OAuth (new users start with no roles)
  fastify.get(
    '/auth/google/start',
    {
      schema: googleStartSchema,
    },
    async (request, reply) => {
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

        // New users from Google start with no roles
        const roles = [];

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
        return reply.status(400).send({
          error: 'REFRESH_TOKEN_REQUIRED',
          message: 'Missing refresh token'
        });
      }

      try {
        // Rotacionar refresh token (emitir novo, revogar antigo)
        const { refreshToken: newRefreshToken, user } = await rotateRefreshToken(refreshToken);
        const accessTokenData = issueAccessToken({ fastify, user });

        return reply.send({
          token: { accessToken: accessTokenData.accessToken },
          refreshToken: newRefreshToken
        });
      } catch (error) {
        if (error?.code === 'INVALID_REFRESH_TOKEN') {
          request.log.warn({ error }, 'Invalid refresh token');
          return reply.status(401).send({
            error: 'INVALID_REFRESH_TOKEN',
            message: 'Invalid refresh token'
          });
        }

        if (error?.code === 'REFRESH_TOKEN_REVOKED') {
          request.log.warn({ error }, 'Refresh token already revoked');
          return reply.status(401).send({
            error: 'REFRESH_TOKEN_REVOKED',
            message: 'Refresh token has been revoked. Please login again.'
          });
        }

        if (error?.code === 'REFRESH_TOKEN_EXPIRED') {
          request.log.info({ error }, 'Refresh token expired');
          return reply.status(401).send({
            error: 'REFRESH_TOKEN_EXPIRED',
            message: 'Refresh token expired. Please login again.'
          });
        }

        if (error?.code === 'USER_DELETED') {
          return reply.status(403).send({
            error: 'USER_DELETED',
            message: 'Account deactivated'
          });
        }

        request.log.error({ error }, 'Token rotation failed');
        return reply.status(500).send({
          error: 'REFRESH_FAILED',
          message: 'Failed to refresh token'
        });
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

  // Change password for authenticated user
  fastify.post(
    '/auth/change-password',
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
        },
      },
      schema: changePasswordSchema,
      onRequest: [authenticate],
    },
    async (request, reply) => {
      try {
        const body = request.body ?? {};
        const currentPassword = body.currentPassword;
        const newPassword = body.newPassword;
        const newPasswordConfirmation = body.newPasswordConfirmation;
        const userId = request.user.id;

        const result = await changePassword({
          userId,
          currentPassword,
          newPassword,
          newPasswordConfirmation,
        });

        // Issue new tokens after password change for security
        const access = issueAccessToken({ fastify, user: result.user });
        const refresh = await issueRefreshToken({ user: result.user });

        return reply.send({
          message: 'Password changed successfully',
          token: { accessToken: access.accessToken },
          refreshToken: refresh.refreshToken,
        });
      } catch (error) {
        if (error?.code === 'CURRENT_PASSWORD_REQUIRED' || error?.code === 'WEAK_PASSWORD' || error?.code === 'PASSWORD_MISMATCH' || error?.code === 'PASSWORD_SAME_AS_CURRENT') {
          return reply.status(400).send({ error: error.code, message: error.message });
        }
        if (error?.code === 'INVALID_CURRENT_PASSWORD') {
          return reply.status(401).send({ error: error.code, message: error.message });
        }
        if (error?.code === 'USER_DELETED') {
          return reply.status(403).send({ error: 'Account deactivated' });
        }
        if (error?.code === 'PASSWORD_NOT_SET') {
          return reply.status(409).send({ error: error.code, message: error.message });
        }

        fastify.log.error(error);
        return reply.status(500).send({ error: 'CHANGE_PASSWORD_FAILED', message: 'Failed to change password' });
      }
    },
  );
}
