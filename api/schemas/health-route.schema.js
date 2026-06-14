const healthResponseSchema = {
  type: 'object',
  required: ['status', 'version', 'uptimeSeconds', 'db'],
  properties: {
    status: { type: 'string', enum: ['ok', 'degraded'] },
    version: { type: 'string' },
    uptimeSeconds: { type: 'number' },
    db: { type: 'string', enum: ['ok', 'down'] },
  },
};

export const getHealthSchema = {
  tags: ['Health'],
  summary: 'Health check — returns service and database status',
  response: {
    200: healthResponseSchema,
    503: healthResponseSchema,
  },
};
