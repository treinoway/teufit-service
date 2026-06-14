import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getHealthStatus } from '../../src/services/health-service.js';

function buildPrismaMock({ queryRawShouldFail = false } = {}) {
  return {
    $queryRaw: queryRawShouldFail
      ? vi.fn().mockRejectedValue(new Error('connection refused'))
      : vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  };
}

describe('health-service', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('getHealthStatus', () => {
    it('returns status ok and db ok when the database is reachable', async () => {
      const prisma = buildPrismaMock();

      const result = await getHealthStatus(prisma);

      expect(result.status).toBe('ok');
      expect(result.db).toBe('ok');
    });

    it('returns status degraded and db down when the database is unreachable', async () => {
      const prisma = buildPrismaMock({ queryRawShouldFail: true });

      const result = await getHealthStatus(prisma);

      expect(result.status).toBe('degraded');
      expect(result.db).toBe('down');
    });

    it('never throws even when the database query rejects', async () => {
      const prisma = buildPrismaMock({ queryRawShouldFail: true });

      await expect(getHealthStatus(prisma)).resolves.not.toThrow();
    });

    it('always includes version as a non-empty string', async () => {
      const prisma = buildPrismaMock();

      const result = await getHealthStatus(prisma);

      expect(typeof result.version).toBe('string');
      expect(result.version.length).toBeGreaterThan(0);
    });

    it('always includes uptimeSeconds as a non-negative number', async () => {
      const prisma = buildPrismaMock();

      const result = await getHealthStatus(prisma);

      expect(typeof result.uptimeSeconds).toBe('number');
      expect(result.uptimeSeconds).toBeGreaterThanOrEqual(0);
    });

    it('returns all required fields in both healthy and degraded scenarios', async () => {
      const healthyPrisma = buildPrismaMock();
      const degradedPrisma = buildPrismaMock({ queryRawShouldFail: true });

      const healthyResult = await getHealthStatus(healthyPrisma);
      const degradedResult = await getHealthStatus(degradedPrisma);

      const requiredFields = ['status', 'version', 'uptimeSeconds', 'db'];
      for (const field of requiredFields) {
        expect(healthyResult).toHaveProperty(field);
        expect(degradedResult).toHaveProperty(field);
      }
    });

    it('does not expose error internals when db is down', async () => {
      const prisma = buildPrismaMock({ queryRawShouldFail: true });

      const result = await getHealthStatus(prisma);

      expect(result).not.toHaveProperty('error');
      expect(result).not.toHaveProperty('stack');
      expect(result).not.toHaveProperty('cause');
    });
  });
});
