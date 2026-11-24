import { describe, it, expect, vi, afterEach } from 'vitest'

const LANGFUSE_ENV_KEYS = [
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_SECRET_KEY',
  'LANGFUSE_BASE_URL',
  'LANGFUSE_TRACING_ENVIRONMENT',
  'LANGFUSE_CONTENT_MODE',
  'LANGFUSE_FORCE_LOCAL',
  'RAILWAY_GIT_COMMIT_SHA',
]
const KEYS = { LANGFUSE_PUBLIC_KEY: 'pk-live', LANGFUSE_SECRET_KEY: 'sk-live' }
const DEFAULT_BASE_URL = 'https://cloud.langfuse.com'
const DEFAULT_FLUSH_AT = 50
const DEFAULT_FLUSH_INTERVAL_SECONDS = 2

// Loads a fresh config snapshot for the given NODE_ENV and env vars.
async function loadConfig(nodeEnv, env = {}) {
  vi.resetModules()
  for (const key of LANGFUSE_ENV_KEYS) vi.stubEnv(key, '')
  vi.stubEnv('NODE_ENV', nodeEnv)
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  return (await import('../../config/index.js')).default.langfuse
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('config.langfuse enablement (AC 1)', () => {
  describe.each(['staging', 'production'])('NODE_ENV=%s with both keys', (nodeEnv) => {
    it('should enable tracing', async () => {
      const langfuse = await loadConfig(nodeEnv, KEYS)

      expect(langfuse.enabled).toBe(true)
    })

    it('should default the tracing environment to NODE_ENV', async () => {
      const langfuse = await loadConfig(nodeEnv, KEYS)

      expect(langfuse.environment).toBe(nodeEnv)
    })

    it('should let LANGFUSE_TRACING_ENVIRONMENT override the environment', async () => {
      const langfuse = await loadConfig(nodeEnv, { ...KEYS, LANGFUSE_TRACING_ENVIRONMENT: 'canary' })

      expect(langfuse.environment).toBe('canary')
    })

    it('should expose the keys', async () => {
      const langfuse = await loadConfig(nodeEnv, KEYS)

      expect({ publicKey: langfuse.publicKey, secretKey: langfuse.secretKey }).toEqual({
        publicKey: KEYS.LANGFUSE_PUBLIC_KEY,
        secretKey: KEYS.LANGFUSE_SECRET_KEY,
      })
    })
  })

  it('should take baseUrl from LANGFUSE_BASE_URL', async () => {
    const langfuse = await loadConfig('production', { ...KEYS, LANGFUSE_BASE_URL: 'https://us.cloud.langfuse.com' })

    expect(langfuse.baseUrl).toBe('https://us.cloud.langfuse.com')
  })

  it('should default baseUrl to the EU cloud', async () => {
    const langfuse = await loadConfig('production', KEYS)

    expect(langfuse.baseUrl).toBe(DEFAULT_BASE_URL)
  })

  it('should take release from RAILWAY_GIT_COMMIT_SHA', async () => {
    const langfuse = await loadConfig('production', { ...KEYS, RAILWAY_GIT_COMMIT_SHA: 'abc123def' })

    expect(langfuse.release).toBe('abc123def')
  })

  it('should leave release null when the commit sha is absent', async () => {
    const langfuse = await loadConfig('production', KEYS)

    expect(langfuse.release).toBeNull()
  })
})

describe('config.langfuse disabled cases (AC 2)', () => {
  it('should be disabled in development even with both keys', async () => {
    const langfuse = await loadConfig('development', KEYS)

    expect(langfuse.enabled).toBe(false)
  })

  it('should be enabled in development with LANGFUSE_FORCE_LOCAL=true and both keys', async () => {
    const langfuse = await loadConfig('development', { ...KEYS, LANGFUSE_FORCE_LOCAL: 'true' })

    expect(langfuse.enabled).toBe(true)
  })

  it('should stay disabled in development with LANGFUSE_FORCE_LOCAL=true but no keys', async () => {
    const langfuse = await loadConfig('development', { LANGFUSE_FORCE_LOCAL: 'true' })

    expect(langfuse.enabled).toBe(false)
  })

  it('should be disabled in test even with keys', async () => {
    const langfuse = await loadConfig('test', KEYS)

    expect(langfuse.enabled).toBe(false)
  })

  it('should be disabled in test even with LANGFUSE_FORCE_LOCAL=true', async () => {
    const langfuse = await loadConfig('test', { ...KEYS, LANGFUSE_FORCE_LOCAL: 'true' })

    expect(langfuse.enabled).toBe(false)
  })

  describe.each(['staging', 'production'])('NODE_ENV=%s', (nodeEnv) => {
    it('should be disabled without the public key', async () => {
      const langfuse = await loadConfig(nodeEnv, { LANGFUSE_SECRET_KEY: 'sk-live' })

      expect(langfuse.enabled).toBe(false)
    })

    it('should be disabled without the secret key', async () => {
      const langfuse = await loadConfig(nodeEnv, { LANGFUSE_PUBLIC_KEY: 'pk-live' })

      expect(langfuse.enabled).toBe(false)
    })

    it('should be disabled when a key is only whitespace', async () => {
      const langfuse = await loadConfig(nodeEnv, { ...KEYS, LANGFUSE_SECRET_KEY: '   ' })

      expect(langfuse.enabled).toBe(false)
    })
  })
})

describe('config.langfuse content mode and flush settings', () => {
  it('should default contentMode to masked', async () => {
    const langfuse = await loadConfig('production', KEYS)

    expect(langfuse.contentMode).toBe('masked')
  })

  it.each(['masked', 'full', 'off'])('should accept LANGFUSE_CONTENT_MODE=%s', async (mode) => {
    const langfuse = await loadConfig('staging', { ...KEYS, LANGFUSE_CONTENT_MODE: mode })

    expect(langfuse.contentMode).toBe(mode)
  })

  it('should fall back to masked for an invalid LANGFUSE_CONTENT_MODE', async () => {
    const langfuse = await loadConfig('staging', { ...KEYS, LANGFUSE_CONTENT_MODE: 'everything' })

    expect(langfuse.contentMode).toBe('masked')
  })

  it('should default the flush settings for the small staging heap', async () => {
    const langfuse = await loadConfig('staging', KEYS)

    expect({ flushAt: langfuse.flushAt, flushIntervalSeconds: langfuse.flushIntervalSeconds }).toEqual({
      flushAt: DEFAULT_FLUSH_AT,
      flushIntervalSeconds: DEFAULT_FLUSH_INTERVAL_SECONDS,
    })
  })
})
