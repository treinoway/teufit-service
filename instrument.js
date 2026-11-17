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
import { buildSentryOptions } from './src/observability/sentry-options.js';

if (config.sentry.dsn) {
  Sentry.init(buildSentryOptions(config));
}
