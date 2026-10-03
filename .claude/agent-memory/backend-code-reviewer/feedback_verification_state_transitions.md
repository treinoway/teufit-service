---
name: verification-state-transitions
description: Side effects gated on "email verified" must fire on every unverified->verified transition, not only on new-user creation; also check resend-resets-attempts brute force
metadata:
  type: feedback
---

When a side effect is gated on email verification (e.g. StudentInvite auto-accept), check EVERY path that flips a user to verified, not just "new user created":
- `findOrCreateUserFromOAuth` has 3 branches: existing account (verifiedAt may be newly set on login), existing user linked by email (unverified email/password user + verified Google/Apple), brand-new user. The implementer gated on `isNewUser` and unit tests locked that in; the linked-existing-user branch then stranded invites because `/auth/verify-email` returns alreadyVerified afterwards. Fixed 2026-09-29.
- Per-code attempt caps are meaningless if resend issues a fresh code with fresh attempts and the only limit is a short cooldown + IP-keyed rate limit. Always compute guesses/day per user.
- "No write on read" expiry (pending + expiresAt < now reported as expired) collides with partial unique indexes on status='pending' — re-create paths must flip stale rows first.
- Status flips driven by a stale read (e.g. `acceptPendingInvitesForUser` expiring an invite read earlier) must repeat the predicate (`expiresAt < now`) in the `updateMany` where, or a concurrent resend that revived the row gets clobbered. Fixed 2026-09-29.
- Tightening "link existing users directly" to "only verified users" silently regresses every legacy email/password account (verifiedAt backfill covers OAuth only) — always ask how legacy users get verified.

**Why:** these gaps pass all tests because the tests encode the same narrow assumption as the code.
**How to apply:** for any verified-gated feature, enumerate verification transitions and ask what happens to pending state in each. Related: [[exercise-copy-flows]] (same "one path missed" failure mode).
