---
name: enumeration-state-oracles
description: Anti-enumeration work fixes the response/latency of the entry endpoint but leaks via the state it leaves for a follow-up public endpoint (verify attempts/expiry) or via awaited email sends
metadata:
  type: feedback
---

Anti-enumeration reviews must check the *follow-up* public endpoints, not only the one made uniform. 2026-10 signup review: /auth/signup was a uniform 202, but only free emails got a PendingSignup, so /auth/signup/verify answered 429 tooManyAttempts after 5 wrong codes for free emails and invalidCode forever for owned ones (6 requests = oracle). Fixed with a never-emailed decoy code on owned emails. Same review: /auth/forgot-password awaited the email provider only on the account branch (latency oracle) — deferred with runAfterResponse.

**Why:** "codeExpired/tooManyAttempts only reveal a pending signup, which anyone can create" was the stated rationale and it was false — the pending row could only exist for emails without an account.

**How to apply:** For every public endpoint keyed by email, enumerate each branch's DB side effects and ask whether ANY later public call (verify, resend, login, reset) observes them differently. Also grep for awaited email sends / extra queries on only one branch. Related: [[verification-state-transitions]] (session revocation must accompany any unverified->verified transition, e.g. password reset).
