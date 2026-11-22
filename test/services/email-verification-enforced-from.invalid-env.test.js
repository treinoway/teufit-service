import { describe, it, expect, vi, afterEach } from 'vitest';

const ENFORCED_FROM_ENV = 'EMAIL_VERIFICATION_ENFORCED_FROM';
const DEFAULT_CUTOFF = '2026-11-18T00:00:00.000Z';
const UNPARSEABLE_VALUES = ['not-a-date', '2026-13-45', 'true', '   '];

// Loads a fresh configuration snapshot with the given environment variables.
async function loadConfig(env = {}) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  return (await import('../../config/index.js')).default;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('config.emailVerification.enforcedFrom with an unparseable EMAIL_VERIFICATION_ENFORCED_FROM', () => {
  it.each(UNPARSEABLE_VALUES)('should load a valid instant for %j', async (value) => {
    const fresh = await loadConfig({ [ENFORCED_FROM_ENV]: value });

    expect(Number.isNaN(new Date(fresh.emailVerification?.enforcedFrom).getTime())).toBe(false);
  });

  it.each(UNPARSEABLE_VALUES)('should fall back to the default cut-off for %j', async (value) => {
    const fresh = await loadConfig({ [ENFORCED_FROM_ENV]: value });

    expect(new Date(fresh.emailVerification?.enforcedFrom).getTime()).toBe(new Date(DEFAULT_CUTOFF).getTime());
  });
});
