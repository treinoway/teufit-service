export default {
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
};
