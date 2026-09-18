const healthResponseSchema = {
  type: 'object',
  required: ['status', 'version', 'uptimeSeconds', 'db', 'memory'],
  properties: {
    status: { type: 'string', enum: ['ok', 'degraded'] },
    version: { type: 'string' },
    uptimeSeconds: { type: 'number' },
    db: { type: 'string', enum: ['ok', 'down'] },
    // Heap pressure, for alerting before an OOM kill. Never affects `status`.
    memory: {
      type: 'object',
      required: ['heapUsedMb', 'heapLimitMb', 'heapUsedPercent', 'rssMb'],
      properties: {
        heapUsedMb: { type: 'number' },
        heapLimitMb: { type: 'number' },
        heapUsedPercent: { type: 'number' },
        rssMb: { type: 'number' },
      },
    },
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
