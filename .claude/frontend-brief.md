# Frontend Brief — Platform Plan in /me + Dev Seeds

**Backend branch**: staging · **Generated**: 2026-05-16

## Elevator pitch
Trainers now receive their full platform subscription details on every `/me` call, so the app can immediately show tier, limits, and real-time usage without a separate API round-trip. A student-only user gets no such field — the distinction is automatic.

## User story
As a trainer, I want to see my current subscription tier, how many students I have, and how many iArnold actions I've used this month, so I can understand my usage at a glance and decide if I need to upgrade.

## User flows
1. **Entry point**: App boot — `AuthContext` fetches `/me` and stores the result. `platformPlan` is available immediately to any component that reads the context.
2. **Happy path**:
   - Trainer opens the app → `/me` returns `platformPlan.tier = 'FREE'` (or PRO/PLATINUM/DIAMOND).
   - `AuthContext` exposes `platformPlan` to all consumers.
   - Dashboard header shows current tier badge.
   - Settings → Plan page shows limits, usage bars, and subscription details.
3. **Branches**:
   - Student-only user: `platformPlan` is absent from `/me`. No plan UI is shown.
   - Trainer with PAST_DUE status: `platformPlan.status = 'PAST_DUE'`. Show payment-overdue banner.
   - Trainer with `cancelAtPeriodEnd: true`: show "cancels on [date]" notice.

## UI states to cover
- **Loading**: skeleton for the plan card while `/me` is in-flight.
- **Empty / student user**: no plan UI — do not render a blank plan card.
- **FREE tier**: show upgrade CTA in prominent position. Disable iArnold button, branding page, and championships CTA.
- **PAST_DUE**: yellow/orange warning banner with payment recovery CTA.
- **CANCELED**: grey badge, "plan expired" message.
- **Null caps**: `studentCap: null` and `aiActionsPerStudent: null` mean unlimited — render as "∞" or "Ilimitado".

## API contract
### GET /me
- **Auth**: Bearer token (any authenticated user)
- **Request**: no body; optional `?include=address,socials,preferences,trainerOnboarding`
- **Success** (200):
  ```json
  {
    "id": "uuid",
    "email": "trainer@example.com",
    "roles": ["trainer"],
    "platformPlan": {
      "tier": "FREE",
      "status": "ACTIVE",
      "currentPeriodEnd": null,
      "cancelAtPeriodEnd": false,
      "limits": {
        "studentCap": 3,
        "aiActionsPerStudent": 0,
        "aiActionsTrainerCap": 0,
        "branding": false,
        "championships": false
      },
      "usage": {
        "students": { "active": 2, "blocked": 0, "cap": 3 },
        "aiActions": {
          "total": 0,
          "byStudent": []
        }
      }
    }
  }
  ```
  - `platformPlan` is **absent** (not null) for student-only users.
  - `studentCap`, `aiActionsPerStudent`, `aiActionsTrainerCap` are `null` when the limit is unlimited (DIAMOND tier).
  - `currentPeriodEnd` is `null` for FREE (no billing period).
  - `usage.students.blocked` counts students marked inactive due to a soft-block after downgrade.
  - `usage.aiActions.byStudent[].count` is the number of iArnold actions used for that student this billing month.

## i18n keys required
Stable messageCodes the frontend needs to translate for this feature:
- `platformPlan.studentCapExceeded` → suggested copy: "Você atingiu o limite de alunos do seu plano."
- `platformPlan.aiNotAvailable` → suggested copy: "iArnold não está disponível no plano Free."
- `platformPlan.aiActionsExceeded` → suggested copy: "Você atingiu o limite de ações do iArnold para este mês."
- `platformPlan.brandingNotAvailable` → suggested copy: "Personalização de marca não está disponível no seu plano."
- `platformPlan.championshipsNotAvailable` → suggested copy: "Campeonatos não estão disponíveis no seu plano."
- `platformPlan.studentBlockedOnPlan` → suggested copy: "Este aluno está bloqueado. Faça upgrade para reativá-lo."

## Acceptance criteria
- [ ] `AuthContext` reads `platformPlan` from the `/me` response and exposes it.
- [ ] `usePlatformPlan()` hook returns `null` when the user is not a trainer (field absent).
- [ ] Plan badge on dashboard/settings shows the correct tier label (FREE, Pro, Platinum, Diamond).
- [ ] Usage bars show `active / cap` (or `∞` when cap is null) for students and iArnold actions.
- [ ] `usage.students.blocked > 0` renders a "X alunos bloqueados" warning.
- [ ] iArnold button is disabled when `limits.aiActionsPerStudent === 0`.
- [ ] Branding page is gated when `limits.branding === false`.
- [ ] Championships CTA is hidden/disabled when `limits.championships === false`.
- [ ] `status === 'PAST_DUE'` renders a payment overdue banner.
- [ ] `cancelAtPeriodEnd === true` shows a cancellation notice with the `currentPeriodEnd` date.
- [ ] Student-only users see no plan UI anywhere in the app.

## Open design questions
- Where does the plan badge live on the trainer dashboard — header, sidebar, or profile dropdown?
- Should the usage bar for iArnold show per-student breakdown or trainer-total only?
- What does the "upgrade" CTA look like when the user is already on DIAMOND?
- How should the "X alunos bloqueados" warning link to the student list?
- Should `PAST_DUE` block navigation to certain pages, or only show a banner?
