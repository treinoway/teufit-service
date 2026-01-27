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
      address: { type: 'object', additionalProperties: true },
      socials: { type: 'object', additionalProperties: true },
    },
  },
  response: {
    200: { type: 'object', additionalProperties: true },
    400: { type: 'object', properties: { error: { type: 'string' } } },
    401: { type: 'object', properties: { error: { type: 'string' } } },
    403: { type: 'object', properties: { error: { type: 'string' } } },
    409: { type: 'object', properties: { error: { type: 'string' } } },
    500: { type: 'object', properties: { error: { type: 'string' } } },
  },
};
