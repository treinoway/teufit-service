const authTags = ['auth'];
import { badRequestErrorResponseSchema, errorResponseSchema } from './error-response.schema.js';

const userIdResponseSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string' },
  },
};

const tokenResponseSchema = {
  type: 'object',
  required: ['accessToken'],
  properties: {
    accessToken: { type: 'string' },
  },
};

export const authSuccessResponseSchema = {
  type: 'object',
  required: ['user', 'token', 'refreshToken'],
  properties: {
    user: userIdResponseSchema,
    token: tokenResponseSchema,
    refreshToken: { type: 'string' },
  },
};

export const signupSchema = {
  tags: authTags,
  summary: 'Sign up with email/password',
  body: {
    type: 'object',
    required: ['email', 'password'],
    additionalProperties: false,
    properties: {
      email: { type: 'string', format: 'email' },
      password: { type: 'string', minLength: 8 },
    },
  },
  response: {
    201: authSuccessResponseSchema,
    400: badRequestErrorResponseSchema,
    403: errorResponseSchema,
    409: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const loginSchema = {
  tags: authTags,
  summary: 'Log in with email/password',
  body: {
    type: 'object',
    required: ['email', 'password'],
    additionalProperties: false,
    properties: {
      email: { type: 'string', format: 'email' },
      password: { type: 'string', minLength: 1 },
    },
  },
  response: {
    200: authSuccessResponseSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    409: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const forgotPasswordSchema = {
  tags: authTags,
  summary: 'Request a password reset email',
  body: {
    type: 'object',
    required: ['email'],
    additionalProperties: false,
    properties: {
      email: { type: 'string', format: 'email' },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        resetToken: {
          type: 'string',
          description: '6-digit reset code (returned only in non-production environments)',
          minLength: 6,
          maxLength: 6,
          pattern: '^[0-9]{6}$',
        },
      },
    },
    400: badRequestErrorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const resetPasswordSchema = {
  tags: authTags,
  summary: 'Reset password using a one-time token',
  body: {
    type: 'object',
    required: ['token', 'password', 'passwordConfirmation'],
    additionalProperties: false,
    properties: {
      token: {
        type: 'string',
        minLength: 6,
        maxLength: 6,
        pattern: '^[0-9]{6}$',
        description: '6-digit reset code sent via email (valid for 15 minutes)',
      },
      password: { type: 'string', minLength: 8 },
      passwordConfirmation: {
        type: 'string',
        minLength: 8,
        description: 'Must match password',
      },
    },
  },
  response: {
    200: authSuccessResponseSchema,
    400: badRequestErrorResponseSchema,
    403: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const googleStartSchema = {
  tags: authTags,
  summary: 'Start Google OAuth (student role)',
  response: {
    302: {
      description: 'Redirects to /auth/google to start the OAuth2 flow',
    },
    400: badRequestErrorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const googleCallbackSchema = {
  tags: authTags,
  summary: 'Google OAuth callback',
  querystring: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'Authorization code from Google' },
      state: { type: 'string', description: 'CSRF protection state value' },
    },
  },
  response: {
    302: {
      description: 'Redirects to the frontend URL after successful authentication',
    },
    400: badRequestErrorResponseSchema,
    403: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const googleMobileSchema = {
  tags: authTags,
  summary: 'Log in with Google ID Token (mobile native SDK)',
  description: 'Receives the idToken from the mobile app, validates it, and returns a session.',
  body: {
    type: 'object',
    required: ['idToken'],
    additionalProperties: false,
    properties: {
      idToken: { type: 'string', description: 'The raw idToken from Google Sign-In SDK' },
    },
  },
  response: {
    200: authSuccessResponseSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const googleWebSchema = {
  tags: authTags,
  summary: 'Log in with Firebase ID Token (web)',
  description: 'Receives the Firebase ID token from the web frontend (signInWithPopup), validates it, and returns a session.',
  body: {
    type: 'object',
    required: ['idToken'],
    additionalProperties: false,
    properties: {
      idToken: { type: 'string', description: 'The Firebase ID token obtained via signInWithPopup with GoogleAuthProvider' },
    },
  },
  response: {
    200: authSuccessResponseSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const refreshSchema = {
  tags: authTags,
  summary: 'Rotate refresh token and get new access token',
  description: 'Exchanges a refresh token for a new access token and a new refresh token. The old refresh token is revoked (token rotation).',
  body: {
    type: 'object',
    required: ['refreshToken'],
    additionalProperties: false,
    properties: {
      refreshToken: { type: 'string' },
    },
  },
  response: {
    200: {
      type: 'object',
      required: ['token', 'refreshToken'],
      properties: {
        token: tokenResponseSchema,
        refreshToken: { type: 'string', description: 'New refresh token to use for future requests' },
      },
    },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const logoutSchema = {
  tags: authTags,
  summary: 'Log out (revoke refresh token)',
  body: {
    type: 'object',
    additionalProperties: false,
    properties: {
      refreshToken: { type: 'string' },
    },
  },
  response: {
    200: { type: 'object', properties: { message: { type: 'string' } } },
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const waitlistSchema = {
  tags: authTags,
  summary: 'Join the waitlist with an email',
  body: {
    type: 'object',
    required: ['email'],
    additionalProperties: false,
    properties: {
      email: { type: 'string', format: 'email' },
    },
  },
  response: {
    201: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        email: { type: 'string' },
        status: { type: 'string' },
      },
    },
    400: badRequestErrorResponseSchema,
    409: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const changePasswordSchema = {
  tags: authTags,
  summary: 'Change password for authenticated user',
  body: {
    type: 'object',
    required: ['currentPassword', 'newPassword', 'newPasswordConfirmation'],
    additionalProperties: false,
    properties: {
      currentPassword: { type: 'string', minLength: 1 },
      newPassword: { type: 'string', minLength: 8 },
      newPasswordConfirmation: {
        type: 'string',
        minLength: 8,
        description: 'Must match newPassword',
      },
    },
  },
  response: {
    200: {
      type: 'object',
      required: ['message', 'token', 'refreshToken'],
      properties: {
        message: { type: 'string' },
        token: tokenResponseSchema,
        refreshToken: { type: 'string' },
      },
    },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    409: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

