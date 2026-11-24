import { ALLOWED_USER_RELATIONS } from '../../src/constants/user-relations.js';
import { badRequestErrorResponseSchema, errorResponseSchema } from './error-response.schema.js';
import { i18nField, i18nArrayField } from '../../src/i18n/schema-helpers.js';
import { PLATFORM_PLAN_TIERS, PLATFORM_SUBSCRIPTION_STATUSES } from '../../src/constants/platform-plan.js';

// Shared across GET /me, PATCH /me/profile (this file), and POST
// /invite/redeem (trainer-invite-route.schema.js) — all three surface the
// same field with the same meaning.
export const betaAccessFieldSchema = {
  type: 'boolean',
  description: 'Always true: signup is open and no invite is required. Kept for clients built during the closed beta.',
};

export const emailVerifiedFieldSchema = {
  type: 'boolean',
  description: 'True if any of the user\'s login accounts has a verified email (OAuth ID token attests it, or the email code was confirmed). Login is not gated on this; clients use it to prompt verification.',
};

const platformPlanShape = {
  type: 'object',
  nullable: true,
  additionalProperties: false,
  description: 'Platform subscription details. Present only when the user has an active trainer profile.',
  properties: {
    tier: { type: 'string', enum: Object.values(PLATFORM_PLAN_TIERS) },
    status: { type: 'string', enum: Object.values(PLATFORM_SUBSCRIPTION_STATUSES) },
    currentPeriodEnd: { type: 'string', format: 'date-time', nullable: true },
    cancelAtPeriodEnd: { type: 'boolean' },
    limits: {
      type: 'object',
      additionalProperties: false,
      properties: {
        studentCap: { type: ['integer', 'null'], description: 'null means unlimited' },
        aiActionsPerStudent: { type: ['integer', 'null'], description: 'null means unlimited' },
        aiActionsTrainerCap: { type: ['integer', 'null'], description: 'null means unlimited' },
        branding: { type: 'boolean' },
        championships: { type: 'boolean' },
      },
    },
    usage: {
      type: 'object',
      additionalProperties: false,
      properties: {
        students: {
          type: 'object',
          additionalProperties: false,
          properties: {
            active: { type: 'integer', minimum: 0 },
            blocked: { type: 'integer', minimum: 0 },
            cap: { type: ['integer', 'null'], description: 'null means unlimited' },
          },
        },
        aiActions: {
          type: 'object',
          additionalProperties: false,
          properties: {
            total: { type: 'integer', minimum: 0 },
            byStudent: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  studentId: { type: 'string', format: 'uuid' },
                  count: { type: 'integer', minimum: 0 },
                },
              },
            },
          },
        },
      },
    },
  },
};

// Dynamically generate allowed relations list from ALLOWED_USER_RELATIONS (includes virtual aliases)
const allowedRelations = [...ALLOWED_USER_RELATIONS];
const allowedRelationsStr = allowedRelations.join(', ');
const allRelationsExample = allowedRelations.join(',');

export const getMeSchema = {
  tags: ['user'],
  summary: 'Get current user profile',
  description: 'Get authenticated user profile with optional relation loading via ?include parameter. By default, returns minimal payload with only base user fields.',
  security: [{ bearerAuth: [] }],
  querystring: {
    type: 'object',
    properties: {
      include: {
        type: 'string',
        description: `Comma-separated list of relations to include. Allowed values: ${allowedRelationsStr}. Default: none (minimal payload). Examples: "${allowedRelations[0]}", "${allowedRelations[0]},${allowedRelations[1]}", "${allRelationsExample}"`,
        examples: [allowedRelations[0], `${allowedRelations[0]},${allowedRelations[1]}`, allowedRelations[2]],
      },
    },
  },
  headers: {
    type: 'object',
    required: ['authorization'],
    properties: {
      authorization: {
        type: 'string',
        description: 'Bearer access token (e.g., "Bearer <token>")',
      },
    },
  },
  response: {
    200: {
      description: 'Current authenticated user profile',
      type: 'object',
      properties: {
        id: { type: 'string', description: 'User id' },
        email: { type: 'string', format: 'email' },
        ...i18nArrayField('roles', 'userRole'),
        ...i18nField('status', 'userStatus'),
        firstName: { type: 'string', nullable: true },
        lastName: { type: 'string', nullable: true },
        ...i18nField('gender', 'userGender', { nullable: true }),
        birthDate: { type: 'string', format: 'date', nullable: true },
        avatarUrl: { type: 'string', nullable: true },
        hasActiveTrainer: { type: 'boolean', description: 'True if user has at least one TrainerStudent link as student' },
        betaAccess: betaAccessFieldSchema,
        emailVerified: emailVerifiedFieldSchema,
        address: {
          type: 'object',
          nullable: true,
          additionalProperties: false,
          description: 'User address, included only if ?include=address is specified',
          properties: {
            id: { type: 'string', description: 'Address record ID' },
            line1: { type: 'string', nullable: true, description: 'Primary street address line' },
            line2: { type: 'string', nullable: true, description: 'Secondary address line (apt, suite, etc.)' },
            neighborhood: { type: 'string', nullable: true, description: 'Neighborhood or district' },
            city: { type: 'string', nullable: true, description: 'City name' },
            state: { type: 'string', nullable: true, description: 'State or province name' },
            stateCode: { type: 'string', nullable: true, description: 'State or province code (e.g., "SP", "CA")' },
            country: { type: 'string', nullable: true, description: 'Country name' },
            countryCode: { type: 'string', nullable: true, description: 'ISO country code (e.g., "BR", "US")' },
            postalCode: { type: 'string', nullable: true, description: 'Postal or ZIP code' },
          },
        },
        socials: {
          type: 'object',
          nullable: true,
          additionalProperties: false,
          description: 'User social networks, included only if ?include=socials is specified',
          properties: {
            id: { type: 'string', description: 'Socials record ID' },
            instagram: { type: 'string', nullable: true, description: 'Instagram handle or URL' },
            whatsapp: { type: 'string', nullable: true, description: 'WhatsApp phone number' },
            x: { type: 'string', nullable: true, description: 'X (Twitter) handle or URL' },
            threads: { type: 'string', nullable: true, description: 'Threads handle or URL' },
            youtube: { type: 'string', nullable: true, description: 'YouTube channel URL' },
            linkedin: { type: 'string', nullable: true, description: 'LinkedIn profile URL' },
            facebook: { type: 'string', nullable: true, description: 'Facebook profile URL' },
          },
        },
        preferences: {
          type: 'object',
          nullable: true,
          description: 'User preferences, included only if ?include=preferences is specified',
          properties: {
            activeProfile: {
              type: 'string',
              description: 'Current active profile for this user',
              enum: ['student', 'trainer', 'nutritionist'],
            },
            rawPreferences: {
              type: 'object',
              nullable: true,
              description: 'Free-form JSON object for frontend app preferences',
              additionalProperties: true,
            },
          },
	      additionalProperties: false,
        },
        trainerOnboarding: {
          type: 'object',
          nullable: true,
          additionalProperties: false,
          description: 'Trainer onboarding milestones, included only if ?include=trainerOnboarding is specified. Null when user is not a trainer.',
          properties: {
            profileCompletedAt: {
              type: 'string',
              nullable: true,
              format: 'date-time',
              description: 'ISO timestamp when the trainer completed their profile (null if not yet done)',
            },
            firstStudentLinkedAt: {
              type: 'string',
              nullable: true,
              format: 'date-time',
              description: 'ISO timestamp when the trainer linked their first student (null if not yet done)',
            },
            firstProtocolCreatedAt: {
              type: 'string',
              nullable: true,
              format: 'date-time',
              description: 'ISO timestamp when the trainer created their first training protocol (null if not yet done)',
            },
            firstStudentInvitedAt: {
              type: 'string',
              nullable: true,
              format: 'date-time',
              description: 'ISO timestamp when the trainer sent their first student invite (null if not yet done)',
            },
            firstAnamnesisSentAt: {
              type: 'string',
              nullable: true,
              format: 'date-time',
              description: 'ISO timestamp when the trainer first assigned an anamnesis to a student (null if not yet done)',
            },
            brandingConfiguredAt: {
              type: 'string',
              nullable: true,
              format: 'date-time',
              description: 'ISO timestamp when the trainer first saved their branding (null if not yet done)',
            },
            profileCompleted: {
              type: 'boolean',
              description: 'True when the trainer has first name, last name and avatar set',
            },
            firstStudentLinked: {
              type: 'boolean',
              description: 'True when the trainer has linked at least one student',
            },
            firstProtocolCreated: {
              type: 'boolean',
              description: 'True when the trainer has created at least one training protocol',
            },
            firstStudentInvited: {
              type: 'boolean',
              description: 'True when the trainer has sent at least one student invite',
            },
            firstAnamnesisSent: {
              type: 'boolean',
              description: 'True when the trainer has assigned an anamnesis to a student at least once',
            },
            brandingConfigured: {
              type: 'boolean',
              description: 'True when the trainer has saved their branding at least once',
            },
          },
        },
        platformPlan: platformPlanShape,
      },
      additionalProperties: false,
    },
    400: {
      description: 'Bad request - invalid relations requested',
      type: 'object',
      required: ['error', 'messageCode', 'message', 'allowedRelations'],
      properties: {
        error: { type: 'string', description: 'Error code (e.g., INVALID_RELATIONS)' },
        messageCode: { type: 'string', description: 'Stable error code for i18n' },
        message: { type: 'string', description: 'Human-readable error message' },
        allowedRelations: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of allowed relation names',
        },
      },
      additionalProperties: true,
    },
    401: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const updateProfileSchema = {
  tags: ['user'],
  summary: 'Update user profile',
  description: 'Update user personal information, address, and social networks. All fields are optional.',
  security: [{ bearerAuth: [] }],
  headers: {
    type: 'object',
    required: ['authorization'],
    properties: {
      authorization: {
        type: 'string',
        description: 'Bearer access token (e.g., "Bearer <token>")',
      },
    },
  },
  body: {
    type: 'object',
    properties: {
      firstName: { type: 'string', minLength: 1, maxLength: 100 },
      lastName: { type: 'string', minLength: 1, maxLength: 100 },
      gender: { type: 'string', enum: ['male', 'female', 'other', 'prefer_not_to_say'] },
      birthDate: { type: 'string', format: 'date', description: 'Date in YYYY-MM-DD format' },
      avatarUrl: { type: 'string', format: 'uri', maxLength: 500 },
      address: {
        type: 'object',
        properties: {
          line1: { type: 'string', maxLength: 200, description: 'Primary street address line' },
          line2: { type: 'string', maxLength: 200, description: 'Secondary address line (apt, suite, etc.)' },
          neighborhood: { type: 'string', maxLength: 100, description: 'Neighborhood or district' },
          city: { type: 'string', maxLength: 100, description: 'City name' },
          state: { type: 'string', maxLength: 100, description: 'State or province name' },
          stateCode: { type: 'string', maxLength: 10, description: 'State or province code (e.g., "SP", "CA")' },
          country: { type: 'string', maxLength: 100, description: 'Country name' },
          countryCode: { type: 'string', maxLength: 3, description: 'ISO country code (e.g., "BR", "US")' },
          postalCode: { type: 'string', maxLength: 20, pattern: '^[0-9]{5}-?[0-9]{3}$', description: 'Brazilian postal code (CEP) with or without hyphen (e.g., "01310-100" or "01310100")' },
        },
        additionalProperties: false,
      },
      socials: {
        type: 'object',
        properties: {
          instagram: { type: 'string', maxLength: 200 },
          whatsapp: { type: 'string', maxLength: 50 },
          x: { type: 'string', maxLength: 200 },
          threads: { type: 'string', maxLength: 200 },
          youtube: { type: 'string', maxLength: 200 },
          linkedin: { type: 'string', maxLength: 200 },
          facebook: { type: 'string', maxLength: 200 },
        },
        additionalProperties: false,
      },
      preferences: {
        type: 'object',
        properties: {
          rawPreferences: {
            type: 'object',
            description: 'Free-form JSON object for frontend app preferences',
            additionalProperties: true,
          },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  response: {
    200: {
      description: 'Updated user profile',
      type: 'object',
      properties: {
        id: { type: 'string' },
        email: { type: 'string' },
        ...i18nArrayField('roles', 'userRole'),
        ...i18nField('status', 'userStatus'),
        firstName: { type: 'string', nullable: true },
        lastName: { type: 'string', nullable: true },
        ...i18nField('gender', 'userGender', { nullable: true }),
        birthDate: { type: 'string', format: 'date', nullable: true },
        avatarUrl: { type: 'string', nullable: true },
        hasActiveTrainer: { type: 'boolean', description: 'True if user has at least one TrainerStudent link as student' },
        betaAccess: betaAccessFieldSchema,
        emailVerified: emailVerifiedFieldSchema,
        address: { type: 'object', nullable: true, additionalProperties: true },
        socials: { type: 'object', nullable: true, additionalProperties: true },
        preferences: { type: 'object', nullable: true, additionalProperties: true },
      },
      additionalProperties: false,
    },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    502: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const becomeTrainerSchema = {
  tags: ['user'],
  summary: 'Set active profile to trainer',
  security: [{ bearerAuth: [] }],
  headers: {
    type: 'object',
    required: ['authorization'],
    properties: {
      authorization: {
        type: 'string',
        description: 'Bearer access token (e.g., "Bearer <token>")',
      },
    },
  },
  response: {
    200: {
      description: 'Updated user preferences with new auth tokens',
      type: 'object',
      properties: {
        activeProfile: {
          type: 'string',
          description: 'The new active profile for this user',
          enum: ['student', 'trainer', 'nutritionist'],
        },
        token: {
          type: 'object',
          properties: {
            accessToken: { type: 'string', description: 'New JWT access token with updated roles' },
          },
          required: ['accessToken'],
        },
        refreshToken: {
          type: 'string',
          description: 'New refresh token',
        },
      },
      required: ['activeProfile', 'token', 'refreshToken'],
      additionalProperties: false,
    },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: {
      description: 'Forbidden. Signup is open: this route no longer answers invite.required (the messageCode stays reserved in the contract)',
      ...errorResponseSchema,
    },
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const becomeNutritionistSchema = {
  tags: ['user'],
  summary: 'Set active profile to nutritionist',
  security: [{ bearerAuth: [] }],
  headers: {
    type: 'object',
    required: ['authorization'],
    properties: {
      authorization: {
        type: 'string',
        description: 'Bearer access token (e.g., "Bearer <token>")',
      },
    },
  },
  response: {
    200: {
      description: 'Updated user preferences with new auth tokens',
      type: 'object',
      properties: {
        activeProfile: {
          type: 'string',
          description: 'The new active profile for this user',
          enum: ['student', 'trainer', 'nutritionist'],
        },
        token: {
          type: 'object',
          properties: {
            accessToken: { type: 'string', description: 'New JWT access token with updated roles' },
          },
          required: ['accessToken'],
        },
        refreshToken: {
          type: 'string',
          description: 'New refresh token',
        },
      },
      required: ['activeProfile', 'token', 'refreshToken'],
      additionalProperties: false,
    },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: {
      description: 'Forbidden. Signup is open: this route no longer answers invite.required (the messageCode stays reserved in the contract)',
      ...errorResponseSchema,
    },
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const deleteMeSchema = {
  tags: ['user'],
  summary: 'Delete own account',
  description: `Soft-deletes and anonymizes the authenticated user's account. Required by App Store guideline 5.1.1(v) and Google Play's account deletion policy.

- Linked social/email accounts (Google/Apple/email), refresh and password-reset tokens.
- Address, social networks, health details, preferences, metabolic profile.
- Workout sessions (and their exercise/set logs).
- Anamnesis responses, AI conversations, gamification records (points, challenge participation).
- Trainer-student / nutritionist-patient links where this user is the student/patient.
- Trainer invites addressed to or redeemed by this user (both by \`userId\` and by email — see below).

- Subscription and payment records (\`StudentSubscription\`), kept for tax/accounting obligations independent of the erasure request.
- Any \`TrainingProtocol\`/\`DietProtocol\` assigned to this user (trainer/nutritionist-owned content, not deleted by the student's own request).

Irreversible. The access token already issued remains valid until it naturally expires; only refresh tokens are revoked immediately.`,
  security: [{ bearerAuth: [] }],
  headers: {
    type: 'object',
    required: ['authorization'],
    properties: {
      authorization: {
        type: 'string',
        description: 'Bearer access token (e.g., "Bearer <token>")',
      },
    },
  },
  response: {
    204: { type: 'null', description: 'Account deleted successfully. No content returned.' },
    401: errorResponseSchema,
    403: {
      description: 'Account already deleted (error: USER_DELETED, messageCode: auth.user.deleted)',
      ...errorResponseSchema,
    },
    404: {
      description: 'User not found (error: USER_NOT_FOUND)',
      ...errorResponseSchema,
    },
    409: {
      description: 'Account has an active trainer or nutritionist profile — self-service deletion is not yet supported for professional accounts (error: PROFESSIONAL_ACCOUNT_DELETION_UNSUPPORTED, messageCode: account.deletion.professionalUnsupported)',
      ...errorResponseSchema,
    },
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const uploadAvatarSchema = {
  tags: ['user'],
  summary: 'Upload user avatar',
  description: `Upload or replace user avatar image.

**Requirements:**
- File must be an image (JPEG, PNG, or WebP)
- Maximum file size: 5MB
- Only one file per request
- File will be stored in S3-compatible storage
- If user already has an avatar, it will be replaced

**Behavior:**
- Generates unique filename based on user ID and file extension
- Old avatar is automatically deleted (if it exists)
- Returns signed avatar URL`,
  security: [{ bearerAuth: [] }],
  consumes: ['multipart/form-data'],
  headers: {
    type: 'object',
    required: ['authorization'],
    properties: {
      authorization: {
        type: 'string',
        description: 'Bearer access token (e.g., "Bearer <token>")',
      },
    },
  },
  response: {
    200: {
      description: 'Avatar uploaded successfully. Returns signed avatar URL.',
      type: 'object',
      properties: {
        avatarUrl: { type: 'string', description: 'Signed avatar URL (temporary, expires in 7 days)' },
      },
      required: ['avatarUrl'],
      additionalProperties: false,
    },
    400: {
      description: 'Bad request - Invalid file, missing file, wrong file type, or file too large',
      type: 'object',
      required: ['error', 'messageCode', 'message'],
      properties: {
        error: {
          type: 'string',
          enum: ['FILE_REQUIRED', 'INVALID_FILE_TYPE', 'FILE_TOO_LARGE'],
          description: 'Error code indicating the specific validation failure',
        },
        messageCode: {
          type: 'string',
          description: 'Stable error code for i18n',
        },
        message: {
          type: 'string',
          description: 'Human-readable error message',
        },
      },
      examples: [
        {
          error: 'FILE_REQUIRED',
          message: 'Avatar file is required',
        },
        {
          error: 'INVALID_FILE_TYPE',
          message: 'Invalid file type. Only JPEG, PNG, and WebP images are allowed. Received: image/gif',
        },
        {
          error: 'FILE_TOO_LARGE',
          message: 'File too large. Maximum size is 5MB. Received: 6.24MB',
        },
      ],
      additionalProperties: true,
    },
    401: errorResponseSchema,
    404: {
      description: 'User not found',
      ...errorResponseSchema,
    },
    502: {
      description: 'Bad Gateway - S3 upload failed',
      ...errorResponseSchema,
    },
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

