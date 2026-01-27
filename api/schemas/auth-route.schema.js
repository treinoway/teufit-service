const authTags = ['auth'];

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
    400: {
      type: 'object',
      properties: {
        error: { type: 'string' },
        message: { type: 'string' },
      },
    },
    409: { type: 'object', properties: { error: { type: 'string' } } },
    403: { type: 'object', properties: { error: { type: 'string' } } },
    500: {
      type: 'object',
      properties: {
        error: { type: 'string' },
        message: { type: 'string' },
      },
    },
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
    400: {
      type: 'object',
      properties: {
        error: { type: 'string' },
        message: { type: 'string' },
      },
    },
    401: { type: 'object', properties: { error: { type: 'string' } } },
    403: { type: 'object', properties: { error: { type: 'string' } } },
    409: { type: 'object', properties: { error: { type: 'string' } } },
    500: {
      type: 'object',
      properties: {
        error: { type: 'string' },
        message: { type: 'string' },
      },
    },
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
        resetToken: { type: 'string' },
      },
    },
    400: {
      type: 'object',
      properties: {
        error: { type: 'string' },
        message: { type: 'string' },
      },
    },
  },
};

export const resetPasswordSchema = {
  tags: authTags,
  summary: 'Reset password using a one-time token',
  body: {
    type: 'object',
    required: ['token', 'password'],
    additionalProperties: false,
    properties: {
      token: { type: 'string', minLength: 1 },
      password: { type: 'string', minLength: 8 },
    },
  },
  response: {
    200: authSuccessResponseSchema,
    400: {
      type: 'object',
      properties: {
        error: { type: 'string' },
        message: { type: 'string' },
      },
    },
    403: { type: 'object', properties: { error: { type: 'string' } } },
    500: {
      type: 'object',
      properties: {
        error: { type: 'string' },
        message: { type: 'string' },
      },
    },
  },
};

export const googleStartSchema = {
  tags: authTags,
  summary: 'Start Google OAuth (student role)',
  response: {
    302: {
      description: 'Redirects to /auth/google to start the OAuth2 flow',
    },
    400: {
      type: 'object',
      properties: {
        error: { type: 'string' },
        message: { type: 'string' },
      },
    },
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
    400: {
      type: 'object',
      properties: {
        error: { type: 'string' },
        message: { type: 'string' },
      },
    },
    403: {
      type: 'object',
      properties: {
        error: { type: 'string' },
      },
    },
    500: {
      type: 'object',
      properties: {
        error: { type: 'string' },
        message: { type: 'string' },
      },
    },
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
    400: {
      type: 'object',
      properties: {
        error: { type: 'string' },
        message: { type: 'string' },
      },
    },
    401: { type: 'object', properties: { error: { type: 'string' } } },
    403: { type: 'object', properties: { error: { type: 'string' } } },
    500: { type: 'object', properties: { error: { type: 'string' } } },
  },
};

export const refreshSchema = {
  tags: authTags,
  summary: 'Exchange refresh token for a new access token',
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
      required: ['token'],
      properties: {
        token: tokenResponseSchema,
      },
    },
    400: { type: 'object', properties: { error: { type: 'string' } } },
    401: { type: 'object', properties: { error: { type: 'string' } } },
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
  },
};
