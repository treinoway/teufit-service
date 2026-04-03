import { badRequestErrorResponseSchema, errorResponseSchema } from './error-response.schema.js';

const trainerProfileResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    firstName: { type: 'string', nullable: true },
    lastName: { type: 'string', nullable: true },
    birthDate: { type: 'string', nullable: true, description: 'Date-only string (YYYY-MM-DD)' },
    avatarUrl: { type: 'string', nullable: true },
    professionalDocument: { type: 'string', nullable: true },
    gymName: { type: 'string', nullable: true },
    notes: { type: 'string', nullable: true },
    serviceMode: {
      type: 'string',
      nullable: true,
      enum: ['online', 'in_person', 'hybrid', null],
    },
    address: {
      type: 'object',
      nullable: true,
      properties: {
        id: { type: 'string', format: 'uuid' },
        line1: { type: 'string', nullable: true },
        line2: { type: 'string', nullable: true },
        neighborhood: { type: 'string', nullable: true },
        city: { type: 'string', nullable: true },
        state: { type: 'string', nullable: true },
        stateCode: { type: 'string', nullable: true },
        country: { type: 'string', nullable: true },
        countryCode: { type: 'string', nullable: true },
        postalCode: { type: 'string', nullable: true },
      },
      additionalProperties: true,
    },
    socialNetworks: {
      type: 'object',
      nullable: true,
      properties: {
        instagram: { type: 'string', nullable: true },
        whatsapp: { type: 'string', nullable: true },
        x: { type: 'string', nullable: true },
        threads: { type: 'string', nullable: true },
        youtube: { type: 'string', nullable: true },
        linkedin: { type: 'string', nullable: true },
        facebook: { type: 'string', nullable: true },
      },
      additionalProperties: true,
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
  additionalProperties: true,
};

export const getTrainerSchema = {
  tags: ['trainer'],
  summary: 'Get the authenticated trainer profile',
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
    200: trainerProfileResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

const trainerListItemSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    firstName: { type: 'string', nullable: true },
    lastName: { type: 'string', nullable: true },
    avatarUrl: { type: 'string', nullable: true },
    serviceMode: {
      type: 'string',
      nullable: true,
      enum: ['online', 'in_person', 'hybrid', null],
    },
    address: {
      type: 'object',
      nullable: true,
      properties: {
        city: { type: 'string', nullable: true },
        state: { type: 'string', nullable: true },
        country: { type: 'string', nullable: true },
      },
    },
    socialNetworks: {
      type: 'object',
      nullable: true,
      additionalProperties: true,
    },
  },
};

export const listTrainersSchema = {
  tags: ['trainer'],
  summary: 'List all active trainers',
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
      type: 'array',
      items: trainerListItemSchema,
    },
    401: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

const studentItemSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    email: { type: 'string', format: 'email' },
    firstName: { type: 'string', nullable: true },
    lastName: { type: 'string', nullable: true },
    avatarUrl: { type: 'string', nullable: true },
  },
};

export const patchTrainerSchema = {
  tags: ['trainer'],
  summary: 'Update trainer profile',
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
    additionalProperties: false,
    properties: {
      trainer: {
        type: 'object',
        additionalProperties: true,
        description: 'Trainer profile fields to update',
        properties: {
          firstName: { type: 'string', description: 'Trainer first name (stored on user)' },
          lastName: { type: 'string', description: 'Trainer last name (stored on user)' },
          birthDate: { type: 'string', format: 'date', description: 'Birth date (YYYY-MM-DD, stored on user)' },
          avatar: { type: 'string', description: 'Avatar URL (stored on user)' },
          professionalDocument: { type: 'string', description: 'Professional registration/document' },
          gymName: { type: 'string', description: 'Gym or organization name' },
          notes: { type: 'string', description: 'Internal notes about the trainer' },
          serviceMode: {
            type: 'string',
            nullable: true,
            description: 'Service mode offered by the trainer',
            enum: ['online', 'in_person', 'hybrid'],
          },
        },
      },
      address: { 
        type: 'object', 
        additionalProperties: false,
        description: 'Address information',
        properties: {
          line1: { type: 'string', description: 'Primary street address line' },
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
        additionalProperties: false,
        description: 'Social media profiles',
        properties: {
          instagram: { type: 'string', nullable: true, description: 'Instagram handle or URL' },
          whatsapp: { type: 'string', nullable: true, description: 'WhatsApp phone number' },
          youtube: { type: 'string', nullable: true, description: 'YouTube channel URL' },
          x: { type: 'string', nullable: true, description: 'X (Twitter) handle or URL' },
          threads: { type: 'string', nullable: true, description: 'Threads handle or URL' },
          linkedin: { type: 'string', nullable: true, description: 'LinkedIn profile URL' },
          facebook: { type: 'string', nullable: true, description: 'Facebook profile URL' },
        },
      },
    },
  },
  response: {
    200: { type: 'object', additionalProperties: true },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    409: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const listStudentsSchema = {
  tags: ['trainer'],
  summary: 'List students linked to the authenticated trainer',
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
      type: 'array',
      items: studentItemSchema,
    },
    401: errorResponseSchema,
    403: errorResponseSchema,
    409: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const searchStudentsSchema = {
  tags: ['trainer'],
  summary: 'Search linked students by name or email',
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
  querystring: {
    type: 'object',
    additionalProperties: false,
    required: ['q'],
    properties: {
      q: {
        type: 'string',
        minLength: 2,
        maxLength: 100,
        description: 'Search text used for fuzzy match over student name and email',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        default: 10,
        description: 'Maximum number of students returned',
      },
    },
  },
  response: {
    200: {
      type: 'array',
      items: studentItemSchema,
    },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    409: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const unlinkStudentSchema = {
  tags: ['trainer'],
  summary: 'Unlink a student from the authenticated trainer',
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
  params: {
    type: 'object',
    required: ['studentId'],
    properties: {
      studentId: {
        type: 'string',
        format: 'uuid',
        description: 'UUID of the student to unlink',
      },
    },
  },
  response: {
    204: { type: 'null', description: 'Student successfully unlinked' },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const linkStudentSchema = {
  tags: ['trainer'],
  summary: 'Link a student to the trainer by email',
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
    required: ['email'],
    additionalProperties: false,
    properties: {
      email: {
        type: 'string',
        format: 'email',
        description: 'Email of the student to link',
      },
    },
  },
  response: {
    201: {
      ...studentItemSchema,
    },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    422: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};
