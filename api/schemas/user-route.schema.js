export const getMeSchema = {
  tags: ['user'],
  summary: 'Get current user profile',
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
        birthDate: { type: 'string', format: 'date', nullable: true },
        avatarUrl: { type: 'string', nullable: true },
        address: {
          type: 'object',
          nullable: true,
          additionalProperties: false,
          description: 'User address, if available',
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
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time', nullable: true },
            deletedAt: { type: 'string', format: 'date-time', nullable: true },
          },
        },
        socials: {
          type: 'object',
          nullable: true,
          additionalProperties: false,
          description: 'User social networks, if available',
          properties: {
            id: { type: 'string', description: 'Socials record ID' },
            instagram: { type: 'string', nullable: true, description: 'Instagram handle or URL' },
            whatsapp: { type: 'string', nullable: true, description: 'WhatsApp phone number' },
            youtube: { type: 'string', nullable: true, description: 'YouTube channel URL' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time', nullable: true },
            deletedAt: { type: 'string', format: 'date-time', nullable: true },
          },
        },
        preferences: {
          type: 'object',
          nullable: true,
          description: 'User preferences, including active profile',
          properties: {
            activeProfile: {
              type: 'string',
              description: 'Current active profile for this user',
              enum: ['student', 'trainer'],
            },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time', nullable: true },
          },
	      additionalProperties: false,
        },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
      },
      additionalProperties: false,
    },
    401: { type: 'object', properties: { error: { type: 'string' } } },
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
