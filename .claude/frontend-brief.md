# Frontend Brief — Bi-set (Superset) + Substitute Exercises

**Backend branch**: staging · **Generated**: 2026-05-10

## Elevator pitch
Trainers can now group exercises into bi-sets/tri-sets that students perform back-to-back, and attach ordered substitute exercises that students can swap in during a workout session when a machine or movement is unavailable. Bi-set members can have substitutes.

## User story
As a **trainer**, I want to combine exercises into a bi-set and attach substitute exercises, so that my students have structured alternatives when they can't perform a prescribed exercise.

As a **student**, I want to swap a prescribed exercise for one of its substitutes during a workout session, so that I can complete my training even when equipment is unavailable.

## User flows

### Trainer — bi-set creation
1. **Entry point**: Training editor, exercise list inside a protocol's training detail view.
2. **Happy path**:
   1. Trainer selects two or more adjacent exercises and taps "Criar bi-set".
   2. The UI generates a fresh UUID as `supersetGroupId` and sends `PATCH /trainer/exercises/:id` for each member (setting the same `supersetGroupId` and consecutive `supersetOrder` values), or passes `supersetGroupId` at creation time via `POST /trainer/trainings/:trainingId/exercises`.
   3. Exercises are returned with a shared `supersetGroupId` — the UI renders them with a visual bracket and "Bi-set" badge.
   4. Trainer can reorder members within the group via `PATCH /trainer/trainings/:trainingId/supersets/:groupId/order`.
3. **Branches**:
   - Members not contiguous → `400 exercise.supersetMembershipInvalid`.
   - More than 6 members → `400 exercise.supersetMaxMembers`.
   - Reorder that splits the group → `400 exercise.supersetMembershipInvalid`.
   - Deleting the second-to-last member → the survivor's `supersetGroupId` becomes `null` automatically; re-render it as a solo exercise.

### Trainer — substitute creation
1. **Entry point**: Exercise row context menu — "Adicionar substituto" action.
2. **Happy path**:
   1. Trainer taps "Adicionar substituto" on a principal exercise.
   2. A composer appears (same exercise fields as normal) bound to that principal.
   3. `POST /trainer/exercises/:id/substitutes` is called.
   4. The substitute appears nested under its principal in the response's `substitutes[]` array.
   5. Trainer reorders substitutes via `PATCH /trainer/exercises/:id/substitutes/order`.
3. **Branches**:
   - Adding a substitute to a substitute → `400 exercise.substituteCannotChain`.
   - Adding a substitute where the candidate (the new exercise) would itself be in a bi-set → `400 exercise.substituteCannotBeInSuperset`. Note: a bi-set member **principal** CAN have substitutes — only the substitute itself cannot be a bi-set member.
   - Candidate is already a substitute for another exercise → `400 exercise.substitutedAlready`.

### Student — swap during workout
1. **Entry point**: Active workout session — exercise log card whose `exercise.substitutes` array is non-empty.
2. **Important**: substitute options live in the **session response** (`exerciseLogs[].exercise.substitutes[]`), NOT in `/my/trainings/:trainingId/exercises`. Always read from the session endpoint.
3. **Happy path**:
   1. Student taps "Trocar exercício" button on an exercise log.
   2. Bottom sheet lists the substitutes in `substituteOrder` order (already present in the session data at `exerciseLog.exercise.substitutes[]`).
   3. Student picks one → `POST /my/workout-sessions/:sessionId/exercise-logs/:logId/substitute` with `{ substituteExerciseId }`.
   4. `201` response returns the new `ExerciseLog` for the substitute, placed at `order = principal.order + 1` (integer).
   5. Principal log is now `status: "substituted"` — show a "Substituído" state.
   6. Existing logs after the principal are shifted up by 1 in `order` automatically.
   7. New log appears immediately after the principal and accepts set logs normally.
4. **Branches**:
   - Log already substituted → `409 exercise.logAlreadySubstituted` — show error toast, disable button.
   - Exercise ID not a valid substitute → `400 exercise.substituteNotFound`.

## UI states to cover
- **Bi-set group**: vertical bracket or colored left border spanning all group members + "Bi-set" badge on first member; no rest separator between members (or shortened indicator).
- **Substitute list in session**: rendered from `exerciseLogs[].exercise.substitutes[]` — show "Trocar exercício" button only when this array is non-empty.
- **No substitutes**: student sees no swap button (`exercise.substitutes` is empty array).
- **Substituted log**: principal log grayed-out / crossed-out with "Substituído" label; new substitute log immediately below.
- **Loading**: spinner while swap endpoint resolves.
- **Error**: toast message using translated `messageCode`.
- **Permissions**: bi-set/substitute creation actions visible to trainers only; swap button visible to students only during an active session.

## API contract

### GET /trainer/trainings/:trainingId/exercises
### GET /my/trainings/:trainingId/exercises
- **Auth**: bearer + TRAINER role (trainer path); any auth (student path)
- **Success** (200): array of principal exercises with nested `substitutes[]`
  ```json
  [
    {
      "id": "uuid",
      "name": "Supino Reto",
      "order": 0,
      "supersetGroupId": "uuid-or-null",
      "supersetOrder": 0,
      "substituteForExerciseId": null,
      "substituteOrder": 0,
      "substitutes": [
        {
          "id": "uuid",
          "name": "Supino Inclinado",
          "substituteForExerciseId": "principal-uuid",
          "substituteOrder": 0
        }
      ]
    }
  ]
  ```
- Substitute exercises do **not** appear as top-level items — nested only.

### GET /my/workout-sessions/:sessionId (and start/update session)
- Session responses embed `exerciseLogs[].exercise.substitutes[]` — this is the authoritative source of swap options during a workout. Do **not** call `/my/trainings/:trainingId/exercises` to populate the swap list.
  ```json
  {
    "exerciseLogs": [
      {
        "id": "log-uuid",
        "exerciseId": "ex-uuid",
        "substitutedByExerciseId": null,
        "status": "pending",
        "order": 2,
        "exercise": {
          "id": "ex-uuid",
          "name": "Supino Reto",
          "substitutes": [
            { "id": "sub-uuid", "name": "Supino Inclinado", "type": "strength", "substituteOrder": 0 }
          ]
        },
        "setLogs": []
      }
    ]
  }
  ```

### POST /trainer/exercises/:id/substitutes
- **Auth**: bearer + TRAINER role
- **Request**: same body as creating a normal exercise (name, type required); `supersetGroupId` and `order` are NOT accepted in this endpoint
- **Success** (201): created substitute Exercise (no `substitutes[]`)
- **Errors**:
  - `404` · `EXERCISE_NOT_FOUND` · `legacy.EXERCISE_NOT_FOUND` · principal not found
  - `400` · `VALIDATION_ERROR` · `exercise.substituteCannotChain` · principal is itself a substitute
  - `400` · `VALIDATION_ERROR` · `exercise.substituteCannotBeInSuperset` · the new substitute exercise is itself in a bi-set group
  - `400` · `VALIDATION_ERROR` · `exercise.substitutedAlready` · candidate already a substitute for another exercise

### PATCH /trainer/exercises/:id/substitutes/order
- **Auth**: bearer + TRAINER role
- **Request**: `{ "substituteIds": ["uuid", "uuid"] }` — full ordered list of all active substitutes
- **Success** (200): `[{ "id": "uuid", "name": "...", "substituteOrder": 0 }, ...]`
- **Errors**:
  - `400` · `VALIDATION_ERROR` · `validation.failed` · list length mismatch or unknown IDs

### PATCH /trainer/trainings/:trainingId/supersets/:groupId/order
- **Auth**: bearer + TRAINER role
- **Request**: `{ "exerciseIds": ["uuid", "uuid"] }` — full ordered list of group members
- **Success** (200): `[{ "id": "uuid", "name": "...", "supersetOrder": 0 }, ...]`
- **Errors**:
  - `404` · `SUPERSET_GROUP_NOT_FOUND` · `exercise.substituteNotFound` · group not found
  - `400` · `VALIDATION_ERROR` · `validation.failed` · list mismatch or unknown IDs

### POST /my/workout-sessions/:sessionId/exercise-logs/:logId/substitute
- **Auth**: bearer (student session owner)
- **Request**: `{ "substituteExerciseId": "uuid" }`
- **Success** (201): new `ExerciseLog` for the substitute
  ```json
  {
    "id": "new-log-uuid",
    "workoutSessionId": "session-uuid",
    "exerciseId": "substitute-exercise-uuid",
    "status": "pending",
    "order": 3,
    "setLogs": []
  }
  ```
  Note: `order` is an **integer** = `principal.order + 1`. All logs after the principal are automatically shifted up by 1.
- **Errors**:
  - `404` · `EXERCISE_LOG_NOT_FOUND` · `legacy.EXERCISE_LOG_NOT_FOUND` · log not found
  - `404` · `EXERCISE_NOT_FOUND` · `legacy.EXERCISE_NOT_FOUND` · substitute exercise not found
  - `400` · `VALIDATION_ERROR` · `exercise.substituteNotFound` · exercise is not a valid substitute for this log
  - `409` · `EXERCISE_LOG_ALREADY_SUBSTITUTED` · `exercise.logAlreadySubstituted` · already substituted

## i18n keys required
- `exercise.supersetMembershipInvalid` → suggested copy: "Os exercícios do bi-set precisam estar em sequência no treino."
- `exercise.supersetMinMembers` → suggested copy: "Um bi-set precisa de pelo menos 2 exercícios."
- `exercise.supersetMaxMembers` → suggested copy: "Um bi-set não pode ter mais de 6 exercícios."
- `exercise.substituteSameTraining` → suggested copy: "O substituto deve pertencer ao mesmo treino."
- `exercise.substituteCannotChain` → suggested copy: "Substitutos não podem ter substitutos."
- `exercise.substituteCannotBeInSuperset` → suggested copy: "O exercício substituto não pode fazer parte de um bi-set."
- `exercise.substitutedAlready` → suggested copy: "Este exercício já é substituto de outro."
- `exercise.substituteNotFound` → suggested copy: "Substituto não encontrado."
- `exercise.logAlreadySubstituted` → suggested copy: "Este exercício já foi substituído nesta sessão."

## Acceptance criteria
- [ ] Trainer can group two adjacent exercises into a bi-set and see a visual group indicator in the training editor.
- [ ] A bi-set member CAN have substitutes; the trainer sees the "Adicionar substituto" option on bi-set members.
- [ ] A reorder that would split a bi-set group is rejected; the UI shows an error toast and the list snaps back.
- [ ] Trainer can add up to 6 substitutes to a principal and reorder them via drag-and-drop.
- [ ] Student's workout session swap button appears only when `exerciseLogs[].exercise.substitutes` is non-empty.
- [ ] Swap list is populated directly from `exerciseLogs[].exercise.substitutes[]` in the session response — no separate API call needed.
- [ ] After a swap, the original exercise log shows a "Substituído" badge; the new log appears immediately after it with an integer `order`.
- [ ] Attempting to re-swap a log that is already substituted shows a conflict error toast.
- [ ] Importing a training template that has bi-sets produces a training with fresh `supersetGroupId` UUIDs (no collision with other imported trainings).

## Out of scope
- Bi-set rest-time automation (rest rules between superset members).
- Nested substitutes (single level only).

## Open design questions
- **Bi-set visual treatment**: vertical bracket vs. colored left border vs. subtle background fill — pick one that works on small screens.
- **Substitute list visibility**: collapsed by default (expand on tap) or always expanded in the trainer editor?
- **Swap confirmation**: one-tap swap or require a confirmation step?
- **Swap button placement**: inline on the exercise log card, or only inside the full exercise detail sheet?
