# Frontend Brief — Student Readiness Indicators

**Backend branch**: staging · **Generated**: 2026-07-15

## Elevator pitch
The trainer's student list now tells them, at a glance, exactly what is stopping each student from being fully operational — no active routine, no plan, a cancelled plan, an overdue payment, or a trainer-side seat/quota block — instead of leaving the trainer to guess or dig into each student's profile.

## User story
As a trainer, I want to see what's blocking each of my students from being ready (no routine, no plan, payment overdue, etc.) directly in my student list, so that I know exactly what action to take for each student without opening their individual profile.

## User flows
1. **Entry point**: The trainer's student roster/list screen (wherever `GET /trainer/students` is currently rendered — student cards or rows).
2. **Happy path**:
   1. Trainer opens the student list.
   2. Each student row/card now carries a readiness signal: either "all good" (no blockers) or one-to-many blocker chips/icons (e.g. "No active routine", "Payment overdue").
   3. Trainer scans the list and immediately spots students needing attention — a student with a cancelled plan, another with no routine assigned, another blocked by the trainer's own seat quota.
   4. Trainer taps a blocker (or the student) to go fix it — e.g. tapping "No active routine" could deep-link to assigning a protocol; tapping "Payment overdue" could deep-link to the subscription/billing screen for that student.
3. **Branches**:
   - A student can show **multiple blockers at once** (e.g. no routine AND an overdue payment simultaneously) — the UI must support showing more than one chip per student, not just a single status label.
   - `blocked_on_plan` is a signal about the **trainer's own** platform plan/seat limit, not something the student did — copy and iconography should make clear this is the trainer's problem to resolve (e.g. "Upgrade your plan"), not a judgment on the student.

## UI states to cover
- **Ready / no blockers**: `ready: true`, `blockers: []` — show a positive/neutral state (e.g. no chip, or a subtle "All set" badge). Do not show an empty blocker row.
- **One blocker**: single chip/icon with the translated label from `blockersLabel`.
- **Multiple blockers**: all present blockers should be visible (stacked chips, a "+N more" affordance, or an expandable list) — array order from the API is intentional and stable, safe to render in that order without re-sorting.
- **Loading**: existing student-list loading state applies (no new loading state — this ships as part of the same response).
- **Permissions**: no change — this is part of the existing trainer-only `GET /trainer/students` response.

## API contract

### GET /trainer/students
- **Auth**: Bearer token, TRAINER role
- **Request**: no change (no new params)
- **Success** (200) — each item in the array gains two fields:
  ```json
  {
    "id": "uuid",
    "email": "student@example.com",
    "firstName": "Ana",
    "lastName": "Silva",
    "avatarUrl": null,
    "adherence": 80,
    "adherenceCompleted": 4,
    "adherenceExpected": 5,
    "adherenceMonth": "2026-07-01",
    "lastWorkoutAt": "2026-07-10T12:00:00.000Z",
    "currentPrLoad": 100,
    "currentPrAt": "2026-07-10T12:00:00.000Z",
    "ready": false,
    "blockers": ["no_active_protocol", "subscription_overdue"],
    "blockersLabel": ["Sem rotina ativa", "Pagamento em atraso"]
  }
  ```
- **Errors**: unchanged from the existing endpoint (401, 403, 409 trainer-profile-missing, 429, 500).

Note: `GET /trainer/students/search` (the fuzzy search endpoint) reuses the same student item shape but does **not** populate `ready`/`blockers` — those fields will be absent/undefined on search results. Don't rely on them there.

## i18n keys required
`blockersLabel` is pre-translated by the backend based on the `app-language` header — the frontend does not need to translate these strings itself, just render them. For reference, the five possible values and their backend-provided pt-BR copy:
- `no_active_protocol` → "Sem rotina ativa"
- `no_subscription` → "Sem plano"
- `subscription_cancelled` → "Plano cancelado"
- `subscription_overdue` → "Pagamento em atraso"
- `blocked_on_plan` → "Bloqueado pela sua cota"

## Acceptance criteria
- [ ] A student with `ready: true` shows no blocker chips (or a clear "all set" indicator, per design).
- [ ] A student with one or more entries in `blockers` shows a chip/badge per entry, using `blockersLabel` text (never hardcode English/Portuguese strings for these — always render the label the API returns).
- [ ] A student with multiple simultaneous blockers renders all of them, not just the first.
- [ ] `blocked_on_plan` is visually/copy-distinct from the other four (it's the trainer's issue, not the student's).
- [ ] The student list continues to work correctly for students returned by `/trainer/students/search`, where these fields are absent (no crash, no blank chip).

## Open design questions
- Visual treatment: colored chips, small icons, or a single "attention needed" badge that expands on tap?
- Should blockers be actionable (deep-link to the fix) in this cycle, or purely informational for now?
- How should `blocked_on_plan` be visually differentiated from student-caused blockers (e.g. a distinct color/icon signaling "this is on you, trainer")?
- Should the student list support filtering/sorting by readiness (e.g. "show not-ready students first")? Not covered by this backend change — worth flagging as a possible fast-follow.
