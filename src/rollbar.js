import Rollbar from 'rollbar';
import config from '../config/index.js';

// Rollbar error tracking. Env-gated: when ROLLBAR_ACCESS_TOKEN is absent (or in
// development without ROLLBAR_FORCE_LOCAL=true), this exports null and callers skip it.
//
// captureUncaught / captureUnhandledRejections install process-level listeners. An
// `uncaughtException` listener stops Node from crashing on its own, so
// exitOnUncaughtException keeps the old behaviour: report, flush, exit(1), and let
// Railway restart the process instead of running on in an unknown state.
export const rollbar = config.rollbar.accessToken
  ? new Rollbar({
      accessToken: config.rollbar.accessToken,
      environment: config.rollbar.environment,
      codeVersion: config.rollbar.codeVersion ?? undefined,
      captureUncaught: true,
      captureUnhandledRejections: true,
      exitOnUncaughtException: true,
      // Added to Rollbar's defaults (authorization, cookie, password, secret, ...).
      scrubFields: ['token', 'accessToken', 'refreshToken', 'code', 'cpf'],
    })
  : null;
