import * as Sentry from '@sentry/node';

// Builds the Sentry.init options, pinning the Anthropic integration so prompts never reach Sentry.
export function buildSentryOptions(config) {
  return {
    dsn: config.sentry.dsn,
    environment: config.sentry.environment,
    tracesSampleRate: config.sentry.tracesSampleRate,
    integrations: [Sentry.anthropicAIIntegration({ recordInputs: false, recordOutputs: false })],
  };
}
