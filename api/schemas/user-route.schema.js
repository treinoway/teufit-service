import { USER_RELATION_CONFIGS } from '../../src/constants/user-relations.js';

// Dynamically generate allowed relations list from USER_RELATION_CONFIGS
const allowedRelations = Object.keys(USER_RELATION_CONFIGS);
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
        roles: {
          type: 'array',
          items: { type: 'string' },
          description: 'User roles (e.g., student, trainer)',
        },
        status: {
          type: 'string',
          description: 'Account status (e.g., pending, active)',
        },
        firstName: { type: 'string', nullable: true },
        lastName: { type: 'string', nullable: true },
        gender: { type: 'string', enum: ['male', 'female', 'other', 'prefer_not_to_say'], nullable: true },
        birthDate: { type: 'string', format: 'date', nullable: true },
        avatarUrl: { type: 'string', nullable: true },
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
              enum: ['student', 'trainer'],
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
      },
      additionalProperties: false,
    },
    400: {
      description: 'Bad request - invalid relations requested',
      type: 'object',
      properties: {
        error: { type: 'string', description: 'Error code (e.g., INVALID_RELATIONS)' },
        message: { type: 'string', description: 'Human-readable error message' },
        allowedRelations: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of allowed relation names',
        },
      },
    },
    401: { type: 'object', properties: { error: { type: 'string' } } },
    404: { type: 'object', properties: { error: { type: 'string' } } },
    500: { type: 'object', properties: { error: { type: 'string' } } },
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
          postalCode: { type: 'string', maxLength: 20, description: 'Postal or ZIP code' },
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
        roles: { type: 'array', items: { type: 'string' } },
        status: { type: 'string' },
        firstName: { type: 'string', nullable: true },
        lastName: { type: 'string', nullable: true },
        gender: { type: 'string', enum: ['male', 'female', 'other', 'prefer_not_to_say'], nullable: true },
        birthDate: { type: 'string', format: 'date', nullable: true },
        avatarUrl: { type: 'string', nullable: true },
        address: { type: 'object', nullable: true, additionalProperties: true },
        socials: { type: 'object', nullable: true, additionalProperties: true },
        preferences: { type: 'object', nullable: true, additionalProperties: true },
      },
      additionalProperties: false,
    },
    400: { type: 'object', properties: { error: { type: 'string' } } },
    404: { type: 'object', properties: { error: { type: 'string' } } },
    500: { type: 'object', properties: { error: { type: 'string' } } },
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
      description: 'Updated user preferences',
      type: 'object',
      properties: {
        activeProfile: {
          type: 'string',
          description: 'The new active profile for this user',
          enum: ['student', 'trainer'],
        },
      },
      required: ['activeProfile'],
      additionalProperties: false,
    },
    400: { type: 'object', properties: { error: { type: 'string' } } },
    401: { type: 'object', properties: { error: { type: 'string' } } },
    500: { type: 'object', properties: { error: { type: 'string' } } },
  },
};
