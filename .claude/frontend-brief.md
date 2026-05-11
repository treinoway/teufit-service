# Frontend Brief — Undo Substitute Swap

**Backend branch**: staging · **Generated**: 2026-05-11

## Elevator pitch
Students can now undo a substitute exercise swap within a 15-second window (before logging any set), reverting the exercise back to the original prescription with a single tap.

## User story
As a **student**, I want to undo a substitute swap before I start logging sets, so that I can correct an accidental swap without abandoning the entire session.

## User flows

1. **Entry point**: Active workout session — an exercise log that is currently showing a substitute (the original exercise is in `status: "substituted"`).
2. **Happy path**:
   1. Student swaps exercise A for substitute B (existing swap flow).
   2. Within the 15-second window a prominent "Desfazer" (undo) button/toast appears on the substitute log.
   3. Student taps "Desfazer".
   4. `DELETE /my/workout-sessions/:sessionId/exercise-logs/:substituteLogId` is called.
   5. `204` is returned — no body.
   6. The substitute log disappears from the list; the original exercise log is restored to `status: "pending"` with `substitutedByExerciseId: null`.
   7. Order gaps are closed automatically; the list re-renders in the correct sequence.
3. **Branches**:
   - Student logs any set before undoing → undo request returns `400 exercise.undoHasSets` — hide or disable the undo button once the first set is saved.
   - 15-second window expires (frontend timer) → hide the undo button proactively, before even attempting the call.
   - Undo already performed (substitute log gone) → `404` — handle gracefully (the UI state is already correct; no error toast needed).

## UI states to cover
- **Undo available**: a 15-second countdown undo button/snackbar on the substitute log card immediately after a swap.
- **Undo expired**: button disappears when timer hits zero OR when the first set is submitted.
- **Loading**: spinner or disabled state while the DELETE resolves.
- **Success**: silent — the list simply returns to its pre-swap state.
- **Error (has sets)**: toast → "Não é possível desfazer: séries já foram registradas." (`exercise.undoHasSets`)
- **Error (generic)**: toast with fallback message for any unexpected 4xx/5xx.
- **Permissions**: undo button visible only on the student's own in-progress session (no trainer view needed).

## API contract

### DELETE /my/workout-sessions/:sessionId/exercise-logs/:exerciseLogId
- **Auth**: bearer (session owner)
- **Params**: `:exerciseLogId` is the **substitute** log ID (the new log created by the swap — NOT the principal).
- **Request**: no body
- **Success** (204): no body
- **Errors** (status · error · messageCode · when):
  - `400` · `VALIDATION_ERROR` · `exercise.undoHasSets` · substitute log already has one or more set logs
  - `400` · `VALIDATION_ERROR` · `exercise.undoNotSubstitute` · the log ID provided is not a substitute log (no principal in the session references it via `substitutedByExerciseId`)
  - `401` · `UNAUTHORIZED` · `auth.unauthorized` · missing/expired token
  - `403` · `FORBIDDEN` · `auth.forbidden` · session belongs to a different user
  - `404` · `EXERCISE_LOG_NOT_FOUND` · `legacy.EXERCISE_LOG_NOT_FOUND` · log not found (already deleted or wrong ID)

## i18n keys required
- `exercise.undoHasSets` → suggested copy: "Não é possível desfazer: séries já foram registradas para este exercício."
- `exercise.undoNotSubstitute` → suggested copy: "Este registro não é um exercício substituto."

## Acceptance criteria
- [ ] Immediately after a swap, the student sees a timed "Desfazer" affordance (≤ 15 seconds) on the substitute log.
- [ ] Tapping "Desfazer" within the window restores the original log to `status: "pending"` and removes the substitute log from the list with no order gap.
- [ ] The undo button disappears automatically when the timer expires — no API call is made after expiry.
- [ ] The undo button disappears immediately when the student saves the first set log on the substitute.
- [ ] After a successful undo the original exercise's swap button is re-enabled.
- [ ] Attempting undo after sets are logged shows a clear error toast (`exercise.undoHasSets`).

## Out of scope
- Undo after the 15-second window (backend enforces no-sets; frontend enforces the timer).
- Trainer-facing undo — this endpoint is student-only.
- Bulk undo / session rollback.

## Open design questions
- **Undo affordance pattern**: floating snackbar with countdown vs. inline button on the substitute log card — which fits the existing session UI better?
- **Timer duration display**: show remaining seconds numerically, or just an animated progress ring?
- **Haptic feedback**: tap haptic on undo confirm?
