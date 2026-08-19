---
name: Config-flag short-circuits silently make same-polarity assertions vacuous
description: When a helper gains a config-gated short-circuit, only opposite-polarity assertions break; same-polarity ones degrade to always-true and test-writer never notices
type: feedback
---

When a change adds a config-flag short-circuit to a shared predicate (e.g. `hasBetaAccess` returning `true` early when `config.betaInviteGate.enabled === false`), audit **both polarities** of every pre-existing assertion on that predicate's output — not just the ones the test run flagged.

**Why:** Test environments frequently default such flags to the "short-circuit" value (`config/environments/test.js` sets `betaInviteGate.enabled: false` so ~29 e2e fixtures can self-promote via `PATCH /become-trainer`). Under that default, assertions expecting the *short-circuited* value silently start passing for the wrong reason and are never revisited, while assertions expecting the *opposite* value fail loudly and get patched. test-writer only ever fixes the loud ones, so the review must catch the quiet ones. Observed on the betaAccess kill-switch fix: three `expect(...betaAccess).toBe(true)` assertions in `test/e2e/trainer-invite.e2e.test.js` became unverifiable while the `toBe(false)` ones were correctly wrapped.

**How to apply:** Grep the test tree for the field/predicate under review, then for each hit ask "would this assertion still pass if the production logic were deleted?" Also reject the pattern of restoring mutated config to a *hardcoded* literal (`finally { config.x.enabled = false }`) instead of the captured prior value — it couples every test to the current `config/environments/test.js` default. And reject `expect(config.x.enabled).toBe(false)` used *in place of* setting it: a test must establish its own precondition, not assert someone else's default. Prefer a nested `describe` with `beforeEach`/`afterEach` over assignment-then-`try`/`finally`, since any throw between the assignment and the `try` leaks the flag into the rest of the file.
