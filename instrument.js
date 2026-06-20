// Sentry instrumentation — MUST be loaded via `node --import ./instrument.js`
// BEFORE the application code (see package.json `start`/`dev`). The @sentry/node
// SDK auto-instruments http/pg/fastify through OpenTelemetry, which can only patch
// those modules if Sentry.init() runs before they are imported. Loaded any later
// (e.g. inside server.js after the route imports), no performance traces are produced.
//
// Env-gated: when SENTRY_DSN is absent, init is skipped and every Sentry call in the
// app is a no-op.
import 'dotenv/config';
import * as Sentry from '@sentry/node';
import config from './config/index.js';

if (config.sentry.dsn) {
  Sentry.init({
    dsn: config.sentry.dsn,
    environment: config.sentry.environment,
    // Distributed tracing. Env-driven (config.sentry.tracesSampleRate): staging
    // runs at 1.0 (SENTRY_TRACES_SAMPLE_RATE=1.0), prod defaults to 0.1.
    tracesSampleRate: config.sentry.tracesSampleRate,
  });
}
