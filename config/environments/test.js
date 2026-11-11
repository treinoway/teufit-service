export default {
  auth: {
    exposeResetTokenInResponse: true,
    // E2E suites re-request codes back to back; the throttle has its own tests
    // that override these values.
    passwordResetCooldownMs: 0,
    passwordResetMaxPerHour: 1000,
  },
  // The closed-beta gate on /become-trainer defaults OFF in the test environment,
  // mirroring how rate limiting is disabled in test (see api/server.js). Dozens of
  // pre-existing e2e fixtures self-promote a fresh user to trainer via
  // PATCH /become-trainer to set up unrelated test data — a global default of
  // "enabled" would 403 all of them. The trainer-invite e2e suite explicitly
  // flips `config.betaInviteGate.enabled = true` for the specific assertions
  // that exercise the gate itself (see test/e2e/trainer-invite.e2e.test.js).
  betaInviteGate: {
    enabled: false,
  },
  // Never report from tests, even with ROLLBAR_ACCESS_TOKEN in a local .env: e2e suites
  // trigger real 5xx (e.g. /admin/debug/rollbar-test) that would land in the real project.
  rollbar: {
    accessToken: null,
  },
  // Never trace from tests, even with Langfuse keys in a local .env.
  langfuse: {
    enabled: false,
  },
};
