import { describe, it, expect } from 'vitest'
import { buildSentryOptions } from '../../src/observability/sentry-options.js'

const ANTHROPIC_INTEGRATION_NAME = 'Anthropic_AI'
const SENTRY_CONFIG = {
  sentry: { dsn: 'https://abc@o1.ingest.invalid/1', environment: 'staging', tracesSampleRate: 0.25 },
}

// Resolves the integrations option (array or function form) to a list.
function integrationsOf(options) {
  return typeof options.integrations === 'function' ? options.integrations([]) : options.integrations
}

describe('buildSentryOptions (AC 13)', () => {
  it('should pin the Anthropic integration to recordInputs false and recordOutputs false', () => {
    const integration = integrationsOf(buildSentryOptions(SENTRY_CONFIG))
      .find((item) => item.name === ANTHROPIC_INTEGRATION_NAME)

    expect(integration.options).toEqual({ recordInputs: false, recordOutputs: false })
  })

  it('should include the Anthropic integration exactly once', () => {
    const names = integrationsOf(buildSentryOptions(SENTRY_CONFIG)).map((item) => item.name)

    expect(names.filter((name) => name === ANTHROPIC_INTEGRATION_NAME)).toHaveLength(1)
  })

  it('should keep the existing dsn, environment and tracesSampleRate behaviour', () => {
    const options = buildSentryOptions(SENTRY_CONFIG)

    expect({ dsn: options.dsn, environment: options.environment, tracesSampleRate: options.tracesSampleRate }).toEqual(SENTRY_CONFIG.sentry)
  })
})
