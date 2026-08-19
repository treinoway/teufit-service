---
name: Helper-extraction refactors land partially
description: When a new shared helper replaces an inline pattern, backend-engineer migrates the call sites it happened to be looking at and leaves siblings behind — grep the old pattern before approving
type: feedback
---

Whenever a change introduces a new helper whose stated purpose is to replace a repeated inline pattern, grep the whole repo for the old pattern and verify every remaining occurrence is either migrated or has an explicit, written rationale for exclusion.

**Why:** The stated exclusion list is usually incomplete. On the `parseBool` (`src/helpers/env.js`) change, the PR summary listed only `NODE_ENV` checks as deliberately skipped, but `src/config/s3-bucket-handler.js` (`DISABLE_S3_UPLOAD === 'true'`) — the direct sibling of the migrated `src/config/email-handler.js`, same directory, same negatively-named-disable-flag shape — was left on the old brittle comparison with no mention at all. A half-migration is worse than none: the codebase now has two conventions and the operator-facing behavior of two adjacent flags diverges.

**How to apply:** Run a regex for the pre-refactor shape (e.g. `process\.env\.[A-Z_]+ *(===|!==) *'(true|false)'`) and diff the hit list against the PR's migrated set. Also check operator-facing docs — `.env.example` and `PROD_ENV_SETUP.md` — since env-parsing changes that widen accepted values are pointless if the docs still tell the operator to type only the old literal.
