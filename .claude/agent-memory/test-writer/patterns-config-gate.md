---
name: Config-driven test-env defaults (betaInviteGate) break assertions silently
description: config/environments/test.js sets betaInviteGate.enabled=false by default; any test relying on the gate-ENABLED code path must force it on and restore it, or it silently short-circuits to the wrong branch
metadata:
  type: feedback
---

`config/environments/test.js` sets `betaInviteGate.enabled: false` by default for
the WHOLE test suite (comment explains: dozens of e2e fixtures self-promote to
trainer via PATCH /become-trainer and would 403 otherwise if the gate defaulted
on). This is a real behavior fork, not a mock — `hasBetaAccess()`
(`src/helpers/beta-access.js`) reads `config.betaInviteGate?.enabled` directly
and short-circuits to `true` for every authenticated user (zero DB hits, no role/
tester-allowlist check) whenever it's `false`.

**Why this bites silently:** any test that mocks `prisma.trainerInvite.findFirst`
and asserts `betaAccess: false` for a plain `roles: []` user is implicitly relying
on the gate being ON. If it isn't, `hasBetaAccess` never reaches the DB lookup at
all — the mock just sits there unused and the assertion fails with `true` instead
of `false`. This happened for real in `test/services/user-service.test.js` (2
tests) when the kill-switch short-circuit was added to `hasBetaAccess`.

**How to apply — before writing/reviewing any test that touches `betaAccess` /
`hasBetaAccess()` / `requireBetaAccess()`:**
1. Decide which branch the test actually wants to exercise:
   - Gate-ENABLED path (role/tester-allowlist exemption, real DB invite lookup) →
     force `config.betaInviteGate.enabled = true` for that test/describe, restore
     it afterward (`afterEach` or `try/finally`).
   - Gate-DISABLED / kill-switch path → either rely on the test-env default
     (`false`) or set it explicitly for clarity; assert the short-circuit `true`
     with **zero** DB calls (`expect(prisma.trainerInvite.findFirst).not.toHaveBeenCalled()`).
2. Always restore the flag to its original value (`false`, the test-env default)
   afterward — it's a shared mutable object (`config` singleton), so leaking a
   flip into other test files/describe blocks is a real risk, not theoretical.
3. Established restore patterns in this repo: `afterEach` at the describe level
   (`test/helpers/beta-access.test.js`), or inline `try { ... } finally { config.betaInviteGate.enabled = false; }`
   wrapped around the act+assert block (`test/e2e/trainer-invite.e2e.test.js`,
   `test/services/user-service.test.js`).
4. In E2E tests, double-check the route under test isn't gated by
   `requireBetaAccess()` itself before flipping the flag for unrelated reasons —
   grep `api/routes/*.js` for `requireBetaAccess` (as of this writing, only
   `PATCH /become-trainer` uses it) so flipping the gate for one assertion in a
   multi-step E2E test doesn't accidentally change the behavior of other calls
   in the same test.

Same root-cause class as [[patterns-intensity]] insofar as both are "a shared
config/helper default changed and every pre-existing test that implicitly
depended on the old default needs an explicit setup line now."
