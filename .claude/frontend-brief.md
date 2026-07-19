# Frontend Brief — Trainer Invite System (Closed Beta)

**Backend branch**: master · **Generated**: 2026-07-19

## Elevator pitch
Teufit web is going into closed beta: only trainers who received an invite email (or code) from an admin can actually use the app. Everyone else who logs in gets redirected to a screen where they can redeem their invite code.

## User story
As an invited trainer, I want to enter the code I received by email (or click the link in that email) so that I can unlock the trainer app and start using it.

As any other logged-in user without an invite, I want to be clearly told the app is invite-only right now and given a place to enter a code, instead of hitting a confusing dead end.

## User flows

1. **Entry point**: A brand-new public route, `/invite`, reachable while a user is authenticated but not yet granted access (do not fold it behind the normal authenticated app shell). Also reachable directly from an email link: `teufit.com.br/invite?code=TW-XXXX-XXXX-XX`.
2. **Happy path**:
   1. User receives an email with an "Aceitar convite" button (linking to `/invite?code=...`) and the same code printed for manual entry.
   2. User clicks the link (or navigates to `/invite` and pastes the code manually) — if arriving with `?code=`, the field is prefilled.
   3. User submits. On success, the app refreshes the session (new tokens, role now includes trainer) and takes them straight into the trainer app.
3. **Branches**:
   - User isn't logged in yet: they should be able to sign up / log in first (with the SAME email the invite was sent to), then land back on `/invite` to redeem.
   - User is already logged in with a different email than the invite: redeeming fails with a clear "this invite belongs to a different email" message — they need to log out and use the invited account.
   - User redeems a code they already redeemed before (e.g. double-click, back button): should succeed silently and feel like nothing broke.
   - Any already-authenticated user without beta access who tries to reach any other part of the trainer app gets bounced to `/invite` instead of seeing a broken/empty screen.

## UI states to cover
- Loading (submitting the code)
- Empty (code field empty, user hasn't typed/pasted anything yet)
- Error states, each with a distinct user-facing message:
  - Unknown/mistyped code
  - Expired invite
  - Revoked invite
  - Invite already used by someone else
  - Invite is for a different email than the one currently logged in
  - Generic/network error
- Success (brief confirmation before redirecting into the app)
- Gate redirect: any signed-in user whose `betaAccess` is `false` should be redirected to `/invite` before reaching any other authenticated screen (trainer dashboard, onboarding, etc.) — this must run before role-based or onboarding-based redirects.

## API contract

### POST /invite/redeem
- **Auth**: required (any authenticated user, any role)
- **Rate limit**: ~10 requests/hour per user
- **Request**:
  ```json
  { "code": "TW-XXXX-XXXX-XX" }
  ```
  Dashes and the `TW-` prefix are optional and matching is case-insensitive — accept whatever the user pastes.
- **Success** (200):
  ```json
  {
    "betaAccess": true,
    "activeProfile": "trainer",
    "token": { "accessToken": "..." },
    "refreshToken": "..."
  }
  ```
  Treat this exactly like the existing "become trainer" token refresh: store the new tokens and re-fetch `/me` so the UI picks up the new role and `betaAccess: true`.
- **Errors** (status · error · messageCode · when):
  - `400` · `VALIDATION_ERROR` · `validation.failed` · code missing/blank
  - `401` · `UNAUTHORIZED` · `auth.unauthorized` · not logged in
  - `403` · `FORBIDDEN` · `invite.revoked` · invite was revoked by an admin
  - `403` · `FORBIDDEN` · `invite.expired` · invite is older than 7 days
  - `403` · `FORBIDDEN` · `invite.emailMismatch` · logged-in email doesn't match the invited email
  - `404` · `NOT_FOUND` · `invite.notFound` · code doesn't match any invite (also covers typos — no enumeration hint given)
  - `409` · `CONFLICT` · `invite.alreadyAccepted` · invite was already redeemed by a different account
  - `429` · — · `request.rateLimitExceeded` · too many attempts

### GET /me (existing endpoint, new field)
- **Auth**: required
- **New response field**: `betaAccess: boolean` — `true` for admins, existing trainers, the bootstrap admin, and anyone with an accepted invite; `false` otherwise. This is the single source of truth for whether the gate redirect should fire. Mobile clients can ignore this field entirely.

### PATCH /become-trainer (existing endpoint, new failure mode)
- **Auth**: required
- Previously anyone could call this to self-promote to trainer. Now blocked for non-exempt users:
  - `403` · `FORBIDDEN` · `invite.required` · user has no admin/trainer role and no accepted invite — if this screen/flow still exists anywhere in the UI, it should surface this as "you need an invite" rather than a generic error.

## i18n keys required
Stable messageCodes the frontend needs to translate for this feature:
- `invite.notFound` → suggested copy: "Convite não encontrado. Verifique o código e tente novamente."
- `invite.expired` → suggested copy: "Este convite expirou. Peça um novo convite."
- `invite.revoked` → suggested copy: "Este convite foi revogado."
- `invite.alreadyAccepted` → suggested copy: "Este convite já foi utilizado."
- `invite.emailMismatch` → suggested copy: "Este convite pertence a outro e-mail. Entre com a conta correta."
- `invite.required` → suggested copy: "Você precisa de um convite para acessar o Teufit durante o teste fechado."

## Acceptance criteria
- [ ] A signed-in user with `betaAccess: false` is redirected to `/invite` from anywhere else in the app, before any other redirect logic runs.
- [ ] `/invite` is reachable without already having beta access (it must be exempt from the gate redirect, or it becomes unreachable).
- [ ] Arriving at `/invite?code=XXXX` prefills the code field; the user can also type/paste it manually with or without dashes.
- [ ] Successful redemption updates the stored session (new tokens) and takes the user into the trainer app without a manual refresh.
- [ ] Each error case above shows a distinct, translated message — no generic "something went wrong" for all of them.
- [ ] Redeeming a code the user already successfully redeemed before does not show an error.
- [ ] Existing trainers and admins never see the `/invite` screen (their `betaAccess` is always `true`).

## Out of scope
- Any admin-facing UI for creating/listing/revoking invites (this cycle ships the redeem-side experience only; invite creation is admin/backend-only for now, e.g. via Postman/internal tooling).
- Trainer-initiated invites (inviting your own colleagues) — the backend has a seam for this but it's not enabled yet.
- Mobile app changes — this entire feature is web-only; the mobile app is unaffected and should ignore `betaAccess`.

## Open design questions
- Visual treatment of the `/invite` screen: reuse the existing auth-card/forgot-password layout, or something more "welcome to the beta" branded?
- Should the code input auto-format as the user types (inserting dashes at TW-XXXX-XXXX-XX boundaries), or accept free-form paste only?
- Copy/tone for the `invite.required` case if a stray UI element still links to "become a trainer" — should that entry point be hidden entirely for non-exempt users instead of surfacing an error after the fact?
- Where should a logged-in user with the wrong email (emailMismatch case) be pointed to log out / switch accounts from the `/invite` screen itself?
