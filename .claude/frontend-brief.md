# Frontend Brief — Beta Gate Kill-Switch Reliability Fix

**Backend branch**: staging · **Generated**: 2026-08-19

## Elevator pitch
The `betaAccess` field on `/me` (the flag the app uses to decide whether to redirect a user to the `/invite` screen) can no longer lie. Previously, if an admin turned the closed-beta gate off server-side (emergency kill-switch), a user without a redeemed invite would still see `betaAccess: false` and get stuck at `/invite` even though the server would have let every other request through. That contradiction is fixed: `betaAccess` now always matches what the server actually enforces.

## User story
As a signed-in user without a redeemed trainer invite, I want `betaAccess` to accurately reflect whether the beta gate is currently active, so that I'm never stranded on the invite-code screen when the gate has been turned off.

## User flows
1. **Entry point**: No new entry point — this affects the existing post-login gate-redirect flow shipped for the trainer invite system (any authenticated screen that checks `betaAccess` before rendering, redirecting to `/invite` when `false`).
2. **Happy path**: User logs in → app reads `betaAccess` from `/me` → if `true`, proceeds normally into the app. No behavior change here.
3. **Branches**: The only behavior change is in the previously-broken case — when an admin has disabled the beta gate server-side, `betaAccess` is now `true` for every authenticated user (admins, trainers, students, and plain users with no invite alike), so nobody is redirected to `/invite` in that state. Before this fix, a plain user with no invite would incorrectly still see `betaAccess: false` and get stuck there.

## UI states to cover
- No new UI states. Re-verify the existing gate-redirect logic (built for the trainer invite feature) has no client-side special-casing or caching layered on top of `betaAccess` to work around the old bug — if any such workaround exists, it can now be removed since the field is trustworthy on its own.

## API contract
### GET /me, PATCH /my/profile, POST /invite/redeem (existing endpoints, no shape change)
- **Auth**: required
- `betaAccess: boolean` — unchanged field name and type. Semantics corrected: it is now guaranteed `true` for every authenticated user whenever the beta gate is administratively disabled, in addition to the existing cases (admin, trainer, accepted invite). No new error responses, no new messageCodes.

## Configuration dependency: two independent kill-switches
`treinoway-web` has its own build-time gate flag, `VITE_BETA_GATE_ENABLED` (read in `src/hooks/useBetaGate.js`), separate from this backend fix and **not corrected by it**. The two flags must be kept in sync manually, and they have **opposite default polarity**:
- Backend (`BETA_INVITE_GATE_ENABLED`): defaults to gate **ENABLED** when unset. Must be explicitly set to a falsy value to disable.
- Frontend (`VITE_BETA_GATE_ENABLED`): defaults to gate **DISABLED** when unset — the redirect is a no-op unless this is the exact literal string `'true'`.

If only the backend switch is flipped off, the frontend still redirects everyone to `/invite` (backend would have let them through, but the client never asks). If only the frontend switch is flipped off, the client stops redirecting but `PATCH /become-trainer` still 403s with `invite.required` server-side. Both sides must move together.

**Decision already made**: prod and staging both keep the gate enabled, so `VITE_BETA_GATE_ENABLED=true` is required at build time in both environments (with the backend `BETA_INVITE_GATE_ENABLED` left unset/default-enabled, per this repo's `PROD_ENV_SETUP.md`).

## Acceptance criteria
- [ ] When the beta gate is disabled server-side, no signed-in user — regardless of role or invite status — is redirected to `/invite`.
- [ ] When the beta gate is enabled, gate-redirect behavior is unchanged from today (only exempt/invited users pass).

## Out of scope
- No new UI, no new screens, no new endpoints. Nothing to build this cycle unless a client-side workaround for the old bug is found and needs removal.
