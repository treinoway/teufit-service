# Frontend Brief — Trainer Onboarding Checklist

**Backend branch**: staging · **Generated**: 2026-04-16

## Elevator pitch
Trainers now have three trackable onboarding milestones that the app can use to guide them through first-time setup. A trainer who completes their profile, links a student, and creates a training protocol for the first time has their progress persisted — and won't see a completed step re-appear as incomplete.

## User story
As a trainer, I want to see a checklist of key first steps when I log in so that I know what actions to take to start using the platform productively.

## User flows

1. **Entry point**: Trainer dashboard or home screen — shown prominently until all three milestones are complete, then hidden/collapsed.
2. **Happy path**:
   1. Trainer opens the app for the first time after becoming a trainer.
   2. The checklist renders with three incomplete steps.
   3. Trainer taps "Complete your profile" → navigates to the profile edit screen.
   4. After saving, the step shows a checkmark and `profileCompleted: true`.
   5. Trainer taps "Link your first student" → navigates to student search/invite.
   6. After linking, `firstStudentLinked: true`.
   7. Trainer taps "Create your first training protocol" → navigates to protocol creation.
   8. After creating, `firstProtocolCreated: true`.
   9. Checklist dismisses (or shows a "you're all set" state) once all three are true.
3. **Branches**:
   - If a trainer already completed some milestones (existing accounts), those steps will arrive pre-checked via the backfill.
   - A student user (no trainer row) will receive `trainerOnboarding: null` — do not render the checklist at all.
   - Each step is independent; the trainer can complete them in any order.

## UI states to cover

- **Loading**: show skeleton or spinner while `GET /me?include=trainerOnboarding` is in flight.
- **All incomplete**: show the checklist prominently (e.g., card on dashboard).
- **Partially complete**: show which steps are done (checked/disabled) and which remain (tappable).
- **All complete**: collapse or hide the checklist; optionally show a one-time congratulation state.
- **Null / not a trainer**: `trainerOnboarding: null` — do not render the component.
- **Network error**: show a non-blocking retry; the checklist is supplementary, not blocking.

## API contract

### GET /me?include=trainerOnboarding

- **Auth**: Bearer token required.
- **Request**: no body. Query param `include=trainerOnboarding` (can combine: `include=trainerOnboarding,address`).
- **Success** (200):
  ```json
  {
    "id": "uuid",
    "email": "trainer@example.com",
    "roles": ["trainer"],
    "firstName": "Ana",
    "trainerOnboarding": {
      "profileCompletedAt": "2025-01-15T10:00:00.000Z",
      "firstStudentLinkedAt": null,
      "firstProtocolCreatedAt": null,
      "profileCompleted": true,
      "firstStudentLinked": false,
      "firstProtocolCreated": false
    }
  }
  ```
  When the user is not a trainer: `"trainerOnboarding": null`.
- **Errors**:
  - `401` · `UNAUTHORIZED` · `auth.unauthorized` · missing or invalid token
  - `400` · `INVALID_RELATIONS` · (not user-facing) · invalid `include` param

### Milestone trigger summary (read-only for frontend)

| Milestone | Triggered by |
|---|---|
| `profileCompleted` | `PATCH /trainer` or `PATCH /me/profile` — when firstName, lastName, birthDate, gender + full address are all set |
| `firstStudentLinked` | `POST /trainer/students` — first successful student link |
| `firstProtocolCreated` | `POST /trainer/protocols` or `POST /trainer/protocols/import-from-template` — first protocol |

Milestones are **write-once** on the backend. The frontend does not need to send anything to mark them; they are set automatically as side-effects of the actions above.

## i18n keys required

Stable messageCodes the frontend needs to translate for this feature:
- `onboarding.profileCompleted` → suggested copy: "Complete seu perfil"
- `onboarding.profileCompleted.description` → suggested copy: "Adicione seus dados pessoais e endereço"
- `onboarding.firstStudentLinked` → suggested copy: "Vincule seu primeiro aluno"
- `onboarding.firstStudentLinked.description` → suggested copy: "Convide um aluno pelo e-mail"
- `onboarding.firstProtocolCreated` → suggested copy: "Crie seu primeiro protocolo"
- `onboarding.firstProtocolCreated.description` → suggested copy: "Monte um treino e atribua a um aluno"
- `onboarding.allDone` → suggested copy: "Você está pronto para treinar!"
- `onboarding.allDone.description` → suggested copy: "Todos os primeiros passos foram concluídos"

## Acceptance criteria

- [ ] The checklist component is rendered on the trainer dashboard when at least one milestone is incomplete.
- [ ] Each step shows a distinct "done" and "pending" visual state.
- [ ] Tapping a pending step navigates to the relevant screen.
- [ ] The checklist is hidden (or collapsed to a "you're all set" summary) when all three booleans are true.
- [ ] `trainerOnboarding: null` results in no checklist being rendered (not even an empty container).
- [ ] The component handles the loading state gracefully without layout shift.
- [ ] Milestone booleans (not timestamps) are used for rendering decisions — timestamps are only used if the designer wants to show "completed on" dates.

## Out of scope

- Any backend changes to trigger milestones differently.
- Reverting or resetting milestones (they are one-way by design).
- Push notifications or in-app alerts triggered by milestone completion.
- Gamification points or badges for completing the checklist.

## Open design questions

- Where exactly on the dashboard should the checklist live — top card, sidebar widget, or modal/drawer on first login?
- Should steps be numbered (ordered) or presented as an unordered checklist?
- After all milestones complete, should the component disappear immediately or show a dismissible success state for one session?
- Should pending steps deep-link directly to the action, or to an explanation screen first?
- Should the timestamps (`profileCompletedAt` etc.) be surfaced in the UI, e.g., "Completed Jan 15"?
