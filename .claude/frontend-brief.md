# Frontend Brief — Student Invite by Email

**Backend branch**: feature/invite-preview-onboarding · **Generated**: 2026-09-29

## Elevator pitch
A trainer can now add a student who has no TeuFit account yet: the student gets an email with app-store links and is added to the trainer's roster automatically once they sign up and confirm their email. The trainer can see, resend and cancel these invites.

## User story
As a trainer, I want to add a student just by typing their email (even if they never used TeuFit) so that they land in my roster as soon as they join, without me chasing them.

## User flows
1. **Entry point**: Trainer web, Students page — the existing "link student" modal, plus a new "Convites" tab/section in the same page.
2. **Happy path (new student)**:
   1. Trainer opens the link modal and types the student's email.
   2. Backend answers `outcome: "invited"` (this also happens when the email belongs to an account whose email is not verified yet: the student is NOT linked until they confirm the email); UI shows "Convite enviado para X" and the invite appears in Convites as Pendente.
   3. Student receives an email, installs the app, signs up with that same email and enters the 6-digit code emailed to them.
   4. Invite flips to Aceito and the student appears in the trainer's roster.
3. **Happy path (student already has a verified account)**: same modal, backend answers `outcome: "linked"`; UI shows "Aluno vinculado" and the student appears in the roster immediately (no invite row). Only in this case trigger the existing first-student onboarding step.
4. **Branches**:
   - Trainer resends a pending or expired invite (1h cooldown, max 5 sends per invite; resending an expired one revives it for 30 more days).
   - Trainer cancels a pending invite.
   - Trainer filters Convites by status (pending / accepted / expired / revoked).
   - Student is over the trainer's plan cap when they finally join: they are still linked, but as inactive on the plan (trainer sees the existing "blocked on plan" blocker). Inviting while already at the cap is refused up front.
   - Student signs up with a different email than invited: no link happens (email copy says to use the invited email).
   - Mobile (separate work): after email signup the app must show a "Verifique seu email" screen; Google/Apple sign-ups with a verified email are auto-accepted with no extra step.

## UI states to cover
- Loading / Empty (no invites yet) / Error / Success for the invites list.
- Status badges: Pendente, Aceito, Expirado, Revogado. Use `status` + `statusLabel` from the API. A pending invite past its expiry is already returned as `expired`.
- Actions availability: drive the Resend button from the server-computed `canResend` (never re-derive it). While `canResend` is false and `resendAvailableAt` is set, show a disabled button with a countdown to that ISO time; when both `canResend` is false and `resendAvailableAt` is null, resend is not possible (accepted/revoked, or 5 sends reached) - hide or disable without countdown. Cancel for pending only.
- Daily limit: a trainer can create at most 50 invites per rolling 24h; show an inline error using `details.retryAfterSeconds` (429). Direct links do not count.
- Resend/invite email delivery failure (502) is shown as a retryable error; a failed resend does not consume the cooldown.
- Modal: explain that unregistered students receive an invite email; toast text depends on `outcome`.
- Permissions: non-trainers get 403.
- Null/absent data: `student` only present for `linked`; `invite` only for `invited`; `studentId` null until accepted.
- `GET /me` now has `emailVerified` (boolean). Login is NOT blocked when false; clients may show a "confirm your email" banner.

## API contract
### POST /trainer/student-invites
- **Auth**: Bearer, role TRAINER (rate limited 20/min)
- **Request**:
  ```json
  { "email": "aluno@example.com" }
  ```
- **Success** (201) — already registered with a verified email:
  ```json
  { "outcome": "linked", "student": { "id": "uuid", "email": "aluno@example.com", "firstName": "Ana", "lastName": "Souza", "avatarUrl": null } }
  ```
- **Success** (201) — not registered, or registered with an unverified email (pending invite, accepted automatically once the student verifies that email):
  ```json
  { "outcome": "invited", "invite": { "id": "uuid", "email": "aluno@example.com", "status": "pending", "statusLabel": "Pendente", "studentId": null, "expiresAt": "2026-10-29T12:00:00.000Z", "acceptedAt": null, "revokedAt": null, "lastSentAt": "2026-09-29T12:00:00.000Z", "sendCount": 1, "createdAt": "2026-09-29T12:00:00.000Z", "canResend": false, "resendAvailableAt": "2026-09-29T13:00:00.000Z" } }
  ```
- **Errors** (status · error · messageCode · when):
  - `400` · `VALIDATION_ERROR` · `validation.failed` · invalid email
  - `403` · `STUDENT_CAP_EXCEEDED` · `platformPlan.studentCapExceeded` · trainer at plan cap (new invites only)
  - `429` · `STUDENT_INVITE_DAILY_LIMIT` · `studentInvite.dailyLimit` · 50 invites created in the last 24h; `details.retryAfterSeconds`
  - `409` · `STUDENT_INVITE_ALREADY_PENDING` · `studentInvite.alreadyPending` · a pending invite already exists (offer Resend)
  - `409` · `CONFLICT` · `student.alreadyLinked` · already in roster
  - `422` · `CANNOT_LINK_SELF` · `student.cannotLinkSelf` · trainer's own email
  - `422` · `STUDENT_ACCOUNT_DEACTIVATED` · `student.accountDeactivated` · the registered user deleted their account

### GET /trainer/student-invites?status=&page=&pageSize=
- **Auth**: Bearer, TRAINER. `status` optional: pending|accepted|revoked|expired. `pageSize` default 20, max 100.
- **Success** (200):
  ```json
  { "items": [ { "id": "uuid", "email": "aluno@example.com", "status": "pending", "statusLabel": "Pendente", "studentId": null, "expiresAt": "...", "acceptedAt": null, "revokedAt": null, "lastSentAt": "...", "sendCount": 1, "createdAt": "...", "canResend": false, "resendAvailableAt": "..." } ], "total": 1, "page": 1, "pageSize": 20 }
  ```
  Newest first.

### POST /trainer/student-invites/:id/resend
- **Auth**: Bearer, TRAINER (10/min)
- **Success** (200): `{ "invite": { ...same shape, sendCount incremented, expiresAt extended, canResend false, resendAvailableAt = now + 1h (null once 5 sends reached) } }`
- **Errors**:
  - `404` · `STUDENT_INVITE_NOT_FOUND` · `studentInvite.notFound`
  - `409` · `STUDENT_INVITE_NOT_PENDING` · `studentInvite.notPending` · accepted/revoked
  - `409` · `STUDENT_INVITE_RESEND_LIMIT` · `studentInvite.resendLimit` · 5 sends reached
  - `429` · `STUDENT_INVITE_RESEND_COOLDOWN` · `studentInvite.resendCooldown` · `details.retryAfterSeconds`
  - `502` · `STUDENT_INVITE_EMAIL_SEND_FAILED` · `studentInvite.emailSendFailed` · email provider failed; nothing was consumed, retry allowed

### DELETE /trainer/student-invites/:id
- **Auth**: Bearer, TRAINER
- **Success** (200): `{ "invite": { ..., "status": "revoked", "canResend": false, "resendAvailableAt": null } }`
- **Errors**: `404` · `studentInvite.notFound`; `409` · `studentInvite.notPending`

### POST /auth/verify-email  (used by mobile)
- **Auth**: Bearer (any user). Rate limited 10/min per user (not per IP).
- **Request**: `{ "code": "123456" }`
- **Success** (200): `{ "verified": true, "linkedTrainers": 1 }`
- **Errors**: `400` `emailVerification.invalidCode` / `emailVerification.codeExpired`; `409` `emailVerification.alreadyVerified`; `429` `emailVerification.tooManyAttempts` (5 wrong tries: request a new code)

### POST /auth/verify-email/resend  (used by mobile)
- **Auth**: Bearer. Rate limited 5/hour per user, 60s cooldown, and at most 5 codes per rolling 24h per user (signup's code counts).
- **Success** (200): `{ "sent": true }`
- **Errors**: `409` `emailVerification.alreadyVerified`; `429` `emailVerification.resendCooldown` or `emailVerification.dailyLimit` (both with `details.retryAfterSeconds`; daily limit = stop offering resend and tell the user to try again later); `502` `emailVerification.sendFailed` (email provider failure; a failed send does not consume the 60s cooldown or the daily cap, so the user can retry immediately)

### GET /me
- New field `emailVerified: boolean`.

### OAuth sign-in with an unverified email (POST /auth/google/mobile, /auth/google/web, /auth/apple/mobile, Google redirect flow)
- Any provider token whose email is not verified is now rejected, whether or not an account exists for that email, and even for an already-linked account. No user is created.
- **Errors**: `403` · `OAUTH_EMAIL_NOT_VERIFIED` · `auth.oauthEmailNotVerified` · token email unverified. The response is identical for new and existing emails.
- UI: show one generic "verify your email with the provider" error on the social sign-in screen; do not branch on account existence. Apple private-relay emails count as verified.

## i18n keys required
- `studentInvite.notFound` → "Convite não encontrado."
- `studentInvite.notPending` → "Este convite não está mais pendente."
- `studentInvite.resendCooldown` → "Aguarde um pouco antes de reenviar este convite."
- `studentInvite.resendLimit` → "Você atingiu o limite de reenvios deste convite."
- `studentInvite.alreadyPending` → "Já existe um convite pendente para este e-mail."
- `student.accountDeactivated` → "A conta deste aluno está desativada."
- `studentInvite.dailyLimit` → "Você atingiu o limite diário de convites. Tente novamente mais tarde."
- `studentInvite.emailSendFailed` → "Não foi possível enviar o e-mail do convite. Tente novamente."
- `auth.oauthEmailNotVerified` → "O e-mail desta conta não está verificado no provedor. Verifique-o e tente novamente."
- `emailVerification.dailyLimit` → "Você solicitou códigos demais hoje. Tente novamente mais tarde."
- `emailVerification.sendFailed` → "Não foi possível enviar o e-mail de verificação. Tente novamente."
- `emailVerification.invalidCode` / `.codeExpired` / `.tooManyAttempts` / `.alreadyVerified` / `.resendCooldown`
- Web-only copy: "Convite enviado para {email}", "Aluno vinculado", tab "Convites", empty state.

## Acceptance criteria
- [ ] Trainer types an unregistered email and sees "Convite enviado para X"; it shows in Convites as Pendente.
- [ ] Trainer types a registered email and sees "Aluno vinculado"; the student is in the roster; no invite row.
- [ ] First-student onboarding fires only for `linked`.
- [ ] Resend button state comes only from `canResend` / `resendAvailableAt`, with a countdown while cooling down.
- [ ] An existing user with an unverified email who is invited receives ONE email with the invite and a verification code (no code if the cooldown/daily cap blocked it; the app's verify screen must offer "request new code"). The trainer sees no difference.
- [ ] Inviting an email whose account is unverified shows "Convite enviado" (not "Aluno vinculado").
- [ ] Cancel moves the invite to Revogado.
- [ ] Filtering by status works and expired pending invites show as Expirado.
- [ ] Duplicate invite shows an actionable "already pending" message.

## Out of scope
- Mobile "Verifique seu email" screen and banner (separate PR).
- Store URLs are placeholders for now (configured on the backend).
- Invite links/codes: acceptance is tied to the verified email only.

## Open design questions
- Convites as a tab, a section, or a drawer on Students?
- Show sent count / "last sent" in each row, and how to present the resend cooldown countdown.
- Copy for the modal explaining registered vs unregistered emails.
- Whether to show an `emailVerified` banner on web too.

---

# Frontend Brief — Password Reset Hardening (BREAKING for web and mobile)

**Backend branch**: feature/invite-preview-onboarding · **Generated**: 2026-10-03

## Elevator pitch
Resetting a password now requires the email together with the 6-digit code, and a code only works for the email it was sent to, with 5 tries per code. Nothing in the flow reveals whether an email has an account.

## User story
As a user who forgot my password, I want to enter my email, the code I received and a new password so that I can recover my account safely.

## User flows
1. **Entry point**: "Forgot password" on the login screen.
2. **Happy path**:
   1. User enters email, taps send. The app always shows the same "if an account exists, we sent a code" confirmation.
   2. User opens the reset form. The email from step 1 must be carried over (prefilled, read-only or editable) because it is now a required field of the reset request.
   3. User enters code, new password and confirmation, submits, and is signed in (same success body as before).
3. **Branches**:
   - Wrong, expired, used or exhausted code, or an email that has no account: ONE generic error ("Invalid or expired code. Request a new one."). Offer a "Request a new code" action. Never differentiate the cases in the UI.
   - After 5 wrong tries the code is dead even if the right one is typed next; the user must request a new code.
   - Requesting codes too often is throttled silently (60s between codes, 5 per hour per email): the response is still the normal 200 but no email is sent. Show a neutral "didn't get it? try again in a minute" hint; do not claim an email was definitely sent.

## UI states to cover
- Loading / Success / Error as usual.
- Generic invalid-code error with a "request a new code" path.
- Validation errors (400 `VALIDATION_ERROR`): weak password (<8), mismatch, malformed code.
- Do NOT show a "account deleted" state: the old 403 `USER_DELETED` on this endpoint is gone.
- Staging/production never return `resetToken` in the forgot-password body; do not rely on it outside local development.

## API contract
### POST /auth/forgot-password
- **Auth**: none. **Request**: `{ "email": "string" }`
- **Success** (200): `{ "message": "..." }` (plus `resetToken` ONLY in development/test).
- **Errors**: `400` · `VALIDATION_ERROR` · `validation.failed`; `429` rate limit.

### POST /auth/reset-password  (CONTRACT CHANGE)
- **Auth**: none.
- **Request**:
  ```json
  { "email": "user@example.com", "code": "123456", "password": "min 8 chars", "passwordConfirmation": "same as password" }
  ```
  The old `token` field is NOT accepted anymore (no alias): it is ignored (a body without `code` gets 400 `VALIDATION_ERROR`). Web and mobile must switch to `code` + `email` in the same release.
- **Success** (200): `{ "user": { "id": "..." }, "token": { "accessToken": "..." }, "refreshToken": "..." }`. All previous sessions of that user are revoked and the email is marked verified.
- **Errors** (status · error · messageCode · when):
  - `400` · `PASSWORD_RESET_INVALID_CODE` · `passwordReset.invalidCode` · unknown email, deleted account, wrong/expired/used code, or more than 5 attempts (all identical)
  - `400` · `VALIDATION_ERROR` · `validation.failed` · missing/malformed field, weak password (`passwordReset.weakPassword`), mismatch (`passwordReset.passwordMismatch`)
  - `429` · rate limit.

## i18n keys required
- `passwordReset.invalidCode` → "Invalid or expired code. Request a new one."
- `passwordReset.weakPassword` → "Password must be at least 8 characters."
- `passwordReset.passwordMismatch` → "Passwords do not match."
- `passwordReset.codeRequired` → "The reset code is required."
- `auth.email.required` → "Email is required."

## Acceptance criteria
- [ ] Reset request sends `email`, `code`, `password`, `passwordConfirmation` (never `token`).
- [ ] Every failure of the code shows the same message and offers a new code.
- [ ] No screen reveals whether an account exists for an email.
- [ ] Email is carried from the forgot-password step into the reset step.

## Out of scope
- Changes to signup, login or OAuth screens.

## Open design questions
- Prefill the email as read-only, or let the user edit it (e.g. when opening the reset from the email link on another device)?
- Wording and placement of the silent-throttle hint on the forgot-password confirmation.

---

# Frontend Brief — Invited Trainer Signup (single inbox confirmation)

**Backend branch**: feature/invite-preview-onboarding · **Generated**: 2026-10-03

## Elevator pitch
An invited trainer creates their account straight from the `/invite` page with just the invite code and a password. No 6-digit email code step: the TF- code in the invite email already proves they own the inbox.

## User story
As an invited trainer, I want to pick a password on the invite page and land signed in as a trainer so that I do not have to confirm my inbox twice.

## User flows
1. **Entry point**: `/invite?code=TF-...` (link from the invite email). The page calls `GET /invite/preview?code=...` first.
2. **Happy path**:
   1. Preview returns `accountExists: false`: show the locked email (from preview) and a password field.
   2. Submit calls `POST /auth/signup/invite { code, password }`.
   3. On 201, store `token.accessToken` and `refreshToken` exactly like the login/verify flows, then go to the trainer onboarding (`activeProfile` is `trainer`, `betaAccess` is `true`).
3. **Branches**:
   - Preview `accountExists: true`: do not show the signup form; send the user to login, then call `POST /invite/redeem` (existing flow).
   - 409 `trainerInvite.accountExists` on submit (account created after the preview): same redirect to login + redeem.
   - 409 `invite.alreadyAccepted` (double submit or code reused): show "invite already used", offer login.

## UI states to cover
- Loading: submit button disabled while the request runs (scrypt makes it take a few hundred ms); prevent double submit.
- Error: invite errors replace the form with a terminal message; password error stays inline.
- Success: signed-in state, redirect.
- Permissions: public endpoint, no auth header.

## API contract
### POST /auth/signup/invite
- **Auth**: none (public). Rate limited per IP (429 `request.rateLimitExceeded`, `retry-after` header).
- **Request**:
  ```json
  { "code": "TF-XXXX-XXXX-XX", "password": "min 8 chars" }
  ```
  The email is NOT sent: it is the one bound to the invite. Code accepts dashes/prefix optional, case-insensitive (max 32 chars).
- **Success** (201):
  ```json
  {
    "user": { "id": "uuid" },
    "token": { "accessToken": "..." },
    "refreshToken": "...",
    "linkedTrainers": 0,
    "betaAccess": true,
    "activeProfile": "trainer"
  }
  ```
  The email is already verified (`emailVerified: true` on `/me`); no verification email is sent. `linkedTrainers` is the number of student invites for that email accepted as a side effect.
- **Errors** (status · error · messageCode · when):
  - `400` · `VALIDATION_ERROR` · `validation.failed` · password shorter than 8, missing/empty code
  - `404` · `INVITE_NOT_FOUND` · `invite.notFound` · unknown or mistyped code
  - `403` · `INVITE_REVOKED` · `invite.revoked` · revoked by admin
  - `403` · `INVITE_EXPIRED` · `invite.expired` · past expiry
  - `409` · `INVITE_ALREADY_ACCEPTED` · `invite.alreadyAccepted` · code already used (also the loser of a concurrent double submit)
  - `409` · `INVITE_ACCOUNT_EXISTS` · `trainerInvite.accountExists` · the invite email already has an account (including a deleted one): sign in and redeem
  - `429` · `TOO_MANY_REQUESTS` · `request.rateLimitExceeded` · per-IP limit

## i18n keys required
- `trainerInvite.accountExists` → "An account already exists for this email. Sign in and redeem the invite." (backend already returns pt-BR/en-US `message`)
- Existing: `invite.notFound`, `invite.revoked`, `invite.expired`, `invite.alreadyAccepted`, `validation.failed`

## Acceptance criteria
- [ ] A valid code + password creates the account and signs the user in without any 6-digit code screen.
- [ ] Every invite error above shows a distinct, translated message.
- [ ] `trainerInvite.accountExists` routes to login with the code preserved so redeem can follow.
- [ ] Double-clicking submit never shows a spurious error to a user who actually succeeded.

## Out of scope
- Changing `/auth/signup`, `/auth/signup/verify`, login or OAuth flows.
- Choosing a different email than the invited one.

## Open design questions
- Where to send the new trainer after signup (trainer onboarding wizard vs dashboard).
- Copy for the "account exists" screen (login-then-redeem hand-off).
