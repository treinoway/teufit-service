import { badRequestErrorResponseSchema, errorResponseSchema } from './error-response.schema.js';

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
