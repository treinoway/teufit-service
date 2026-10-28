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

const signupEmailProperty = { type: 'string', format: 'email', maxLength: 254 };
const signupPasswordProperty = { type: 'string', minLength: 8 };

export const signupSchema = {
  tags: authTags,
  summary: 'Start an email/password signup (always 202, no account enumeration)',
  description:
    'Does NOT create the account. Always answers 202 { status: "pending_verification" } for a well-formed body, '
    + 'whether or not the email already has an account. In the background: no account → a 6-digit code is emailed '
    + '(60s cooldown, max 5 codes/24h, both silent); existing account → a "you already have an account" email '
    + '(max 1 per 15 min); deleted account → nothing. Finish with POST /auth/signup/verify. '
    + 'The password is validated here but NOT stored: send it again to /auth/signup/verify.',
  body: {
    type: 'object',
    required: ['email', 'password'],
    additionalProperties: false,
    properties: {
      email: signupEmailProperty,
      password: signupPasswordProperty,
    },
  },
  response: {
    202: {
      type: 'object',
      required: ['status'],
      properties: {
        status: { type: 'string', enum: ['pending_verification'] },
      },
    },
    400: badRequestErrorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const signupVerifySchema = {
  tags: authTags,
  summary: 'Confirm a pending signup with the emailed code and create the account',
  description:
    'Creates the user (email already verified), accepts pending trainer invites for the email and returns tokens. '
    + 'The password sent here becomes the account password. 400 emailVerification.invalidCode covers wrong code, '
    + 'no pending signup and email already registered (indistinguishable). 400 emailVerification.codeExpired, '
    + '429 emailVerification.tooManyAttempts (5 per code) → request a new code via /auth/signup/resend. '
    + 'Rate limited per IP and per email (429 request.rateLimitExceeded).',
  body: {
    type: 'object',
    required: ['email', 'code', 'password'],
    additionalProperties: false,
    properties: {
      email: signupEmailProperty,
      code: { type: 'string', pattern: '^[0-9]{6}$', description: '6-digit numeric code sent by email' },
      password: signupPasswordProperty,
    },
  },
  response: {
    201: {
      type: 'object',
      required: ['user', 'token', 'refreshToken', 'linkedTrainers'],
      properties: {
        user: userIdResponseSchema,
        token: tokenResponseSchema,
        refreshToken: { type: 'string' },
        linkedTrainers: { type: 'integer', minimum: 0, description: 'Number of trainer invites accepted for this email' },
      },
    },
    400: badRequestErrorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const signupResendSchema = {
  tags: authTags,
  summary: 'Re-send the signup code (always 202)',
  description:
    'Always 202 { sent: true } for a well-formed email. Cooldown (60s), daily cap (5 codes/24h) and delivery '
    + 'failures are applied silently; an email with an existing account gets the "you already have an account" '
    + 'email instead. Clients should run the 60s countdown locally.',
  body: {
    type: 'object',
    required: ['email'],
    additionalProperties: false,
    properties: {
      email: signupEmailProperty,
    },
  },
  response: {
    202: {
      type: 'object',
      required: ['sent'],
      properties: {
        sent: { type: 'boolean', enum: [true] },
      },
    },
    400: badRequestErrorResponseSchema,
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
          description: '6-digit reset code. Returned ONLY when config.auth.exposeResetTokenInResponse is on (development and test); never in staging or production.',
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
  summary: 'Reset password using the emailed code',
  description:
    'The code is bound to the email it was sent to. Unknown email, deleted account, missing/used/expired code, wrong code and too many attempts (5 per code) all return the same 400 `PASSWORD_RESET_INVALID_CODE` / `passwordReset.invalidCode`. Dispatch: when `email` is present the body must carry `code` (new contract; if `token` is also sent it is ignored). Without `email`, the deprecated `token` field (old mobile versions) is accepted while the temporary legacy path is enabled: it is matched against all active codes, answers the same 400 invalid code unless exactly one matches, is throttled by global 30/min and 100/hour buckets, and is switched off by a circuit breaker after repeated wrong codes until restart. When the legacy path is disabled or neither field is usable, a missing code answers 400 `VALIDATION_ERROR` / `passwordReset.codeRequired`.',
  body: {
    type: 'object',
    required: ['password', 'passwordConfirmation'],
    additionalProperties: false,
    properties: {
      email: { type: 'string', format: 'email', description: 'Email the reset code was requested for (required with `code`)' },
      code: {
        type: 'string',
        minLength: 6,
        maxLength: 6,
        pattern: '^[0-9]{6}$',
        description: '6-digit reset code sent via email (valid for 15 minutes, 5 attempts)',
      },
      token: {
        type: 'string',
        minLength: 6,
        maxLength: 6,
        pattern: '^[0-9]{6}$',
        deprecated: true,
        description: 'Legacy field of old mobile versions (the same 6-digit code, sent without email). Temporary: removed after the mobile release that sends email + code.',
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

export const appleMobileSchema = {
  tags: authTags,
  summary: 'Log in with Apple identity token (mobile native Sign in with Apple)',
  description:
    'Receives the identityToken from the iOS app (Sign in with Apple), validates it against Apple\'s JWKS, and returns a session. `email` is only present on the user\'s first authorization — subsequent logins omit it, so the account must already exist. Optional `nonce` is the raw nonce used at sign-in for replay protection.',
  body: {
    type: 'object',
    required: ['identityToken'],
    additionalProperties: false,
    properties: {
      identityToken: { type: 'string', description: 'The raw identityToken (JWT) from the Sign in with Apple SDK' },
      authorizationCode: { type: 'string', description: 'Optional authorization code from Apple (reserved for future server-to-server token exchange)' },
      nonce: { type: 'string', description: 'Optional raw nonce used at sign-in; server validates SHA256(nonce) against the token nonce claim' },
    },
  },
  response: {
    200: authSuccessResponseSchema,
    201: authSuccessResponseSchema,
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


export const verifyEmailSchema = {
  tags: authTags,
  summary: 'Verify the authenticated user\'s email with the 6-digit code',
  description: 'Marks the email account verified and auto-accepts pending trainer invites for the email. Max 5 attempts per code; code expires in 30 minutes.',
  security: [{ bearerAuth: [] }],
  body: {
    type: 'object',
    required: ['code'],
    additionalProperties: false,
    properties: {
      code: { type: 'string', pattern: '^[0-9]{6}$', description: '6-digit numeric code sent by email' },
    },
  },
  response: {
    200: {
      type: 'object',
      required: ['verified', 'linkedTrainers'],
      properties: {
        verified: { type: 'boolean' },
        linkedTrainers: { type: 'integer', minimum: 0, description: 'Number of trainer invites accepted as a result of verifying' },
      },
    },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const resendEmailVerificationSchema = {
  tags: authTags,
  summary: 'Resend the email verification code (60s cooldown, max 5 codes per 24h)',
  description: 'Rate limited per user. 429 emailVerification.resendCooldown or emailVerification.dailyLimit (both with details.retryAfterSeconds). 502 emailVerification.sendFailed when the email provider rejects the send.',
  security: [{ bearerAuth: [] }],
  response: {
    200: {
      type: 'object',
      required: ['sent'],
      properties: {
        sent: { type: 'boolean' },
      },
    },
    401: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
    502: errorResponseSchema,
  },
};

export const signupInviteSchema = {
  tags: authTags,
  summary: 'Sign up through a trainer invite code (no 6-digit email code)',
  description:
    'Closed-beta signup for an invited trainer. The TF- invite code proves inbox ownership, so the account is created '
    + 'with a verified email, the trainer role and the invite is accepted, all in one transaction. The email comes from '
    + 'the invite (see GET /invite/preview). Password rules are the same as /auth/signup/verify. '
    + 'Errors: 404 invite.notFound, 403 invite.revoked / invite.expired, 409 invite.alreadyAccepted, '
    + '409 trainerInvite.accountExists (the email already has an account, including a deleted one: sign in and redeem '
    + 'via POST /invite/redeem), 400 validation.failed (e.g. password shorter than 8). Rate limited per IP '
    + '(429 request.rateLimitExceeded).',
  body: {
    type: 'object',
    required: ['code', 'password'],
    additionalProperties: false,
    properties: {
      code: { type: 'string', minLength: 1, maxLength: 32, description: 'Invite code, e.g. TF-XXXX-XXXX-XX. Dashes/prefix are optional and case-insensitive.' },
      password: signupPasswordProperty,
    },
  },
  response: {
    201: {
      type: 'object',
      required: ['user', 'token', 'refreshToken', 'linkedTrainers', 'betaAccess', 'activeProfile'],
      properties: {
        user: userIdResponseSchema,
        token: tokenResponseSchema,
        refreshToken: { type: 'string' },
        linkedTrainers: { type: 'integer', minimum: 0, description: 'Number of student invites accepted for this email' },
        betaAccess: { type: 'boolean', description: 'Same as POST /invite/redeem; always true here.' },
        activeProfile: { type: 'string', description: 'Always "trainer" here.' },
      },
    },
    400: badRequestErrorResponseSchema,
    403: { description: 'Forbidden: invite.revoked or invite.expired', ...errorResponseSchema },
    404: { description: 'Not found: invite.notFound', ...errorResponseSchema },
    409: { description: 'Conflict: invite.alreadyAccepted or trainerInvite.accountExists', ...errorResponseSchema },
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};
