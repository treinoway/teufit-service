import fastifyOauth2 from '@fastify/oauth2';
import 'dotenv/config';
import config from '../../config/index.js';
import {
  findOrCreateUserFromOAuth,
  findAccountByProvider,
  findUserByEmailInsensitive,
} from '../../src/helpers/auth.js';
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
import { verifyAppleIdToken } from '../../src/services/apple-id-token-service.js';
import { verifyFirebaseIdToken } from '../../src/services/firebase-id-token-service.js';
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
  appleMobileSchema,
  googleWebSchema,
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
      config: { rateLimit: config.rateLimit.auth.waitlist },
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
      config: { rateLimit: config.rateLimit.auth.login },
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
          return reply.status(401).send({ error: 'INVALID_CREDENTIALS', messageCode: 'auth.invalidCredentials', message: 'Invalid email or password.' });
        }
        if (error?.code === 'USER_DELETED') {
          return reply.status(403).send({
            error: 'USER_DELETED',
            messageCode: 'auth.user.deleted',
            message: 'Account deactivated',
            details: {},
          });
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
      config: { rateLimit: config.rateLimit.auth.forgotPassword },
      schema: forgotPasswordSchema,
    },
    async (request, reply) => {
      try {
        const body = request.body ?? {};
        const email = body.email;

        const { resetToken, deliveryEmail } = await requestPasswordReset({ email });

        const payload = {
          message: 'If an account exists for this email, a reset link has been sent.',
        };

        // In non-production, expose the token to simplify manual testing.
        if (process.env.NODE_ENV !== 'production' && resetToken) {
          payload.resetToken = resetToken;
        }

        if (!resetToken || !deliveryEmail) {
          return reply.send(payload);
        }

        try {
          await emailHandler.sendResetPasswordEmail({ to: deliveryEmail, passwordToken: resetToken });
        } catch (emailErr) {
          fastify.log.error(`Failed to send password reset email to ${deliveryEmail}: ${emailErr.message}`);
        }

        return reply.send(payload);
      } catch (error) {
        if (error?.code === 'EMAIL_REQUIRED') {
          return reply.status(400).send({
            error: error.code,
            messageCode: 'auth.email.required',
            message: error.message,
            details: {},
          });
        }

        fastify.log.error(error);
        return reply.status(500).send({
          error: 'FORGOT_PASSWORD_FAILED',
          messageCode: 'auth.forgotPassword.failed',
          message: 'Failed to process password reset request',
          details: {},
        });
      }
    },
  );

  // Reset password with token (stateless)
  fastify.post(
    '/auth/reset-password',
    {
      config: { rateLimit: config.rateLimit.auth.resetPassword },
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
          return reply.status(400).send({
            error: error.code,
            messageCode: `legacy.${error.code}`,
            message: error.message,
            details: {},
          });
        }
        if (error?.code === 'USER_DELETED') {
          return reply.status(403).send({
            error: 'USER_DELETED',
            messageCode: 'auth.user.deleted',
            message: 'Account deactivated',
            details: {},
          });
        }
        if (error?.code === 'JWT_NOT_CONFIGURED') {
          return reply.status(500).send({
            error: 'JWT_NOT_CONFIGURED',
            messageCode: 'auth.jwt.notConfigured',
            message: error.message,
            details: {},
          });
        }

        fastify.log.error(error);
        return reply.status(500).send({
          error: 'RESET_PASSWORD_FAILED',
          messageCode: 'auth.resetPassword.failed',
          message: 'Failed to reset password',
          details: {},
        });
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
          return reply.status(403).send({
            error: 'USER_DELETED',
            messageCode: 'auth.user.deleted',
            message: 'Account deactivated',
            details: {},
          });
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

  // Mobile-native Apple auth (Sign in with Apple):
  // iOS app performs the native Apple flow and sends the identityToken here.
  // Apple only returns `email` on the user's FIRST authorization — later logins
  // omit it, so an account with that Apple `sub` must already exist by then.
  fastify.post(
    '/auth/apple/mobile',
    {
      schema: appleMobileSchema,
    },
    async (request, reply) => {
      try {
        const body = request.body ?? {};
        const identityToken = body.identityToken ?? body.identity_token;

        if (!identityToken) {
          return reply.status(400).send({
            error: 'APPLE_IDENTITY_TOKEN_REQUIRED',
            messageCode: 'auth.apple.identityTokenRequired',
            message: 'Missing Apple identity token',
            details: {},
          });
        }

        const apple = await verifyAppleIdToken({
          identityToken,
          audience: process.env.APPLE_BUNDLE_ID,
          nonce: body.nonce,
        });

        // Determine login vs first-time sign-up BEFORE creating anything, so we
        // can both reject email-less first logins and answer 201 on create.
        const account = await findAccountByProvider('apple', apple.subject);
        let created = false;

        if (!account) {
          if (!apple.email) {
            // First Apple login MUST carry an email; Apple never resends it.
            return reply.status(401).send({
              error: 'AUTH_APPLE_FIRST_LOGIN_REQUIRES_EMAIL',
              messageCode: 'auth.apple.firstLoginRequiresEmail',
              message: 'First Apple login requires an email. Please sign in again.',
              details: {},
            });
          }
          const existingByEmail = await findUserByEmailInsensitive(apple.email);
          created = !existingByEmail;
        }

        // New users from Apple start with no roles (same default as Google mobile)
        const user = await findOrCreateUserFromOAuth({
          provider: 'apple',
          providerId: apple.subject,
          email: apple.email,
          name: apple.email,
          avatar: null,
          accessToken: null,
          refreshToken: null,
          expiresAt: null,
          roles: [],
        });

        const token = issueAccessToken({ fastify, user });
        const refreshTokenData = await issueRefreshToken({ user });

        return reply.status(created ? 201 : 200).send({
          user: { id: user.id },
          token: { accessToken: token.accessToken },
          refreshToken: refreshTokenData.refreshToken,
        });
      } catch (error) {
        if (error?.code === 'USER_DELETED') {
          return reply.status(403).send({
            error: 'USER_DELETED',
            messageCode: 'auth.user.deleted',
            message: 'Account deactivated',
            details: {},
          });
        }
        if (error?.code === 'APPLE_IDENTITY_TOKEN_REQUIRED') {
          return reply.status(400).send({
            error: 'APPLE_IDENTITY_TOKEN_REQUIRED',
            messageCode: 'auth.apple.identityTokenRequired',
            message: 'Missing Apple identity token',
            details: {},
          });
        }
        if (error?.code === 'APPLE_AUDIENCE_REQUIRED') {
          // Server misconfiguration (no APPLE_BUNDLE_ID) — never leak internals.
          fastify.log.error(error);
          return reply.status(500).send({
            error: 'APPLE_AUTH_FAILED',
            messageCode: 'auth.apple.failed',
            message: 'Authentication failed',
            details: {},
          });
        }
        if (
          error?.code === 'APPLE_NONCE_MISMATCH' ||
          error?.code === 'INVALID_APPLE_ISSUER' ||
          error?.code === 'APPLE_SUBJECT_MISSING' ||
          error?.code === 'ERR_JWT_EXPIRED' ||
          error?.code === 'ERR_JWS_INVALID' ||
          error?.code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' ||
          error?.code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' ||
          error?.code === 'ERR_JWKS_NO_MATCHING_KEY'
        ) {
          return reply.status(401).send({
            error: 'AUTH_APPLE_INVALID_TOKEN',
            messageCode: 'auth.apple.invalidToken',
            message: 'Invalid Apple token',
            details: {},
          });
        }

        fastify.log.error(error);
        return reply.status(500).send({
          error: 'APPLE_AUTH_FAILED',
          messageCode: 'auth.apple.failed',
          message: 'Authentication failed',
          details: {},
        });
      }
    },
  );

  // Web Google auth via Firebase ID token (signInWithPopup):
  // Web frontend obtains a Firebase ID token and sends it here.
  // Returns a Bearer access token (JWT) to be used in Authorization header.
  fastify.post(
    '/auth/google/web',
    {
      schema: googleWebSchema,
    },
    async (request, reply) => {
      try {
        const body = request.body ?? {};
        const idToken = body.idToken;

        if (!idToken) {
          return reply.status(400).send({ error: 'ID_TOKEN_REQUIRED', messageCode: 'auth.idToken.required', message: 'Missing idToken' });
        }

        const firebase = await verifyFirebaseIdToken({
          idToken,
          projectId: process.env.FIREBASE_PROJECT_ID,
        });

        if (!firebase.email) {
          return reply.status(400).send({ error: 'GOOGLE_EMAIL_REQUIRED', messageCode: 'auth.google.emailRequired', message: 'Google account email not available' });
        }

        const user = await findOrCreateUserFromOAuth({
          provider: 'google',
          providerId: firebase.subject,
          email: firebase.email,
          name: firebase.name ?? firebase.email,
          avatar: firebase.picture,
          accessToken: null,
          refreshToken: null,
          expiresAt: null,
          roles: [],
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
          return reply.status(403).send({ error: 'USER_DELETED', messageCode: 'auth.user.deleted', message: 'Account deactivated' });
        }
        if (error?.code === 'ID_TOKEN_REQUIRED') {
          return reply.status(400).send({ error: 'ID_TOKEN_REQUIRED', messageCode: 'auth.idToken.required', message: 'Missing idToken' });
        }
        if (error?.code === 'FIREBASE_PROJECT_ID_REQUIRED' || error?.code === 'INVALID_FIREBASE_TOKEN') {
          return reply.status(401).send({ error: 'GOOGLE_AUTH_FAILED', messageCode: 'auth.google.failed', message: 'Invalid Firebase token' });
        }
        if (error?.code === 'ERR_JWT_EXPIRED') {
          return reply.status(401).send({ error: 'GOOGLE_TOKEN_EXPIRED', messageCode: 'auth.google.tokenExpired', message: 'Google token expired' });
        }
        if (error?.code === 'ERR_JWS_INVALID' || error?.code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
          return reply.status(401).send({ error: 'GOOGLE_AUTH_FAILED', messageCode: 'auth.google.failed', message: 'Invalid Google token' });
        }

        fastify.log.error(error);
        return reply.status(500).send({ error: 'GOOGLE_AUTH_FAILED', messageCode: 'auth.google.failed', message: 'Authentication failed' });
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
      config: { rateLimit: config.rateLimit.auth.changePassword },
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
