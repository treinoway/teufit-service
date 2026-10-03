---
name: feedback-tx-mirroring-helpers
description: backend-engineer copies the steps of singleton-bound helpers into a tx-local function instead of giving the helper an optional tx client; prefer the `{ tx }` param
metadata:
  type: feedback
---

When a flow needs an existing helper (e.g. setActiveProfileToTrainer / ensureProfileForUser) inside an interactive transaction, the backend-engineer tends to write a "mirror" function with a subset of the steps, justified by "the helper uses the prisma singleton". The mirror silently drifts when the original gains a step. The established codebase pattern is `const db = tx ?? prisma` (trainer-onboarding-service.js maybeMark*), and the user accepted adding `{ tx }` to setActiveProfileToTrainer/ensureProfileForUser in the invite-signup review (2026-10-03).

**Why:** duplicated grant logic = two trainer-creation paths that diverge; the DI rule in CLAUDE.md also favours passing the client.

**How to apply:** when a review finds a "mirrors X but on tx" helper, diff it against X and recommend (or do) the optional-tx refactor; check unit tests that mock X still assert the tx is forwarded. Related: [[feedback-concurrency-write-paths]].
