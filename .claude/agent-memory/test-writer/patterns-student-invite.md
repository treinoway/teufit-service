---
name: Student invite / email verification test patterns
description: How to capture verification codes and invite emails in E2E, plus gotchas (rate limits off, details omitted, activeOnPlan not exposed)
metadata:
  type: feedback
---

- E2E: `vi.spyOn(emailHandler, 'sendEmailVerificationEmail').mockImplementation(({to, code}) => map.set(to, code))` in beforeEach (singleton instance; restoreMocks restores). Same for `sendStudentInviteEmail`.
- Rate limiting is disabled when NODE_ENV=test, so 429s in E2E come only from service-level cooldowns (backdate `lastSentAt` / token `createdAt` via prisma to bypass).
- Error bodies omit `details` when there is none — do not assert `toHaveProperty('details')` generally.
- GET /trainer/students does NOT expose `activeOnPlan`; assert `blockers` contains `StudentBlocker.BLOCKED_ON_PLAN` instead.
- FREE tier studentCap is 3; fill with prisma.user.create + prisma.trainerStudent.create. `createTrainer` should call provisionTrainerPlan(trainerId, tier).
- Unit: services take `prisma` as argument — build a fake with `$transaction: cb => cb(prisma)`; use vi.useFakeTimers for cooldown maths. user-service test mock needs `account.findFirst` default null in beforeEach (mockReset is on).
- `npm run test:e2e -- <file>` runs the WHOLE suite (script ignores args); for one file use `npx vitest run --config vitest.e2e.config.js <file>`.
- Existing users from `signup` are UNVERIFIED (invite creates pending, no direct link). For direct-link E2E use `signupVerified` (signup + verify with captured code). Unit fakes need `account.findFirst`, `trainerStudent.findUnique`, `studentInvite.findMany` (daily cap) defaults.
- Daily caps (invites 50, codes 5): seed rows via prisma `createMany` with explicit `createdAt`; signup-issued token is "now", so backdate it or the 60s cooldown fires before the daily cap.
- `userRateLimitKey` in auth-route.js is not exported; rate limits are off in test env, so it is untested.
- Unverified-user invite now sends `sendExistingUserStudentInviteEmail` (not `sendStudentInviteEmail`); E2E spies both. Signup token is "now" so cooldown blocks issuing (code null) unless you backdate the user's tokens first. Failed sends set `used=true` + `sendFailedAt` (excluded from cooldown/cap); a failed resend still invalidates the prior delivered code.
- After a schema change run `npx prisma generate` before E2E, otherwise new columns give PrismaClientValidationError (swallowed by "Safely" helpers -> confusing mass failures).
- student-dashboard adherence tests (unit + e2e) fail on the last day of a month (calendar-month dependent) - unrelated flake.
- Code issuing: `issueCode` creates a row only; older rows are closed by `confirmVerificationCodeDelivered` AFTER a successful send (failed send keeps the old code valid). Unit mocks of email-verification-service need `isUserEmailVerified`, `confirmVerificationCodeDelivered`, `markEmailVerifiedFromInboxProof`; issued shape is `{code, tokenId, userId, createdAt}`.
- Hijack/OAuth-link e2e lives in test/e2e/email-verification-hardening.e2e.test.js. `vi.spyOn(prisma.<model>, 'create')` does NOT intercept in e2e (delegates differ) - cover "db failure" branches in unit tests.
- POST /auth/signup may be concurrently reworked to 202 pending-signup; use test/helpers/legacy-user.js `seedLegacyUnverifiedUser` for unverified password users.
