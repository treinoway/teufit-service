# Frontend Brief — Inline Previous Performance (previousLog)

**Backend branch**: staging · **Generated**: 2026-05-26

## Elevator pitch
When a student opens a workout session, each exercise now shows what they did last time — sets, reps, and load — right inside the session detail, with no extra requests needed.

## User story
As a student, I want to see my last logged performance for each exercise inline while I work out, so that I can track my progression and aim to beat previous numbers without navigating away from the active session.

## User flows
1. **Entry point**: Student opens an active or past workout session via the session detail screen (accessed from the home screen, the active session banner, or the session history list).
2. **Happy path**:
   - Student opens a session.
   - Each exercise card in the session now shows a "última vez" (last time) section beneath the prescription info.
   - The section lists previous sets: e.g. "Série 1: 10 reps × 80 kg", "Série 2: 8 reps × 80 kg".
   - For time-based exercises, it shows duration: "Série 1: 30 min".
   - Student uses the data as a target while logging the current session.
3. **Branches**:
   - First-time exercise (no prior history): the "última vez" section is hidden or shows a "Primeira vez aqui!" empty state.
   - Substituted exercise: if the student swapped to a substitute exercise in this session, the previousLog reflects the substitute's history (not the original exercise's). No special UI needed — the data is correct automatically.

## UI states to cover
- **Has history**: show `previousLog.setLogs` items in a compact list below the exercise prescription. Show `previousLog.finishedAt` as a relative date (e.g. "Há 7 dias").
- **No history** (`previousLog === null`): hide the section entirely, or show a subtle "Primeira vez" label — do not show an empty list.
- **Loading**: skeleton row in place of the previous performance section while the session GET is in-flight.
- **Empty setLogs** (`previousLog` is non-null but `setLogs` is `[]`): treat the same as null — the student had a session but logged no completed sets. Hide the section.

## API contract

### GET /my/workout-sessions/:sessionId
- **Auth**: student token required
- **Success** (200): full session object with `exerciseLogs[].previousLog` embedded

Each `exerciseLog` now includes:
```json
{
  "previousLog": {
    "workoutSessionId": "uuid",
    "finishedAt": "2026-05-19T10:45:00.000Z",
    "setLogs": [
      { "setNumber": 1, "repetitions": 10, "load": 80.0, "duration": null },
      { "setNumber": 2, "repetitions": 8,  "load": 80.0, "duration": null }
    ]
  }
}
```

Or when no history exists:
```json
{ "previousLog": null }
```

Field semantics:
- `repetitions`: integer or null (null for time-based exercises)
- `load`: number (kg) or null (null for bodyweight/duration exercises)
- `duration`: integer (seconds) or null (null for rep-based exercises)
- `setLogs` contains only completed sets; incomplete sets are excluded at the data layer.
- `notes`, `rpe`, `restSeconds` are intentionally absent from `previousLog.setLogs`.

No new endpoint is required. No extra requests from the frontend.

- **Errors**:
  - `404` · `WORKOUT_SESSION_NOT_FOUND` · `resource.notFound` · session not found or soft-deleted
  - `403` · `FORBIDDEN_NOT_YOUR_SESSION` · `resource.forbidden` · session belongs to another user

## i18n keys required
No new `messageCode` values are introduced. This is a data enrichment — no new error paths.

Suggested UI copy for the frontend i18n files:
- `session.previousLog.label` → "Última vez" (pt-BR) / "Last time" (en-US)
- `session.previousLog.date` → "Há {days} dias" / "{days} days ago"
- `session.previousLog.firstTime` → "Primeira vez" / "First time"
- `session.previousLog.setItem.reps` → "Série {n}: {reps} reps × {load} kg"
- `session.previousLog.setItem.duration` → "Série {n}: {duration}"

## Acceptance criteria
- [ ] Each exercise card in the session detail shows a "Última vez" section when `previousLog` is non-null and `setLogs.length > 0`.
- [ ] The section is hidden (not rendered) when `previousLog` is null or `setLogs` is empty.
- [ ] The date displayed (relative to today) is derived from `previousLog.finishedAt`.
- [ ] Rep-based sets display repetitions and load; duration-based sets display duration.
- [ ] The previous performance section is read-only — no interaction targets.
- [ ] Loading skeleton is shown while the session GET is pending.
- [ ] No additional API requests are made to populate the previous performance data.
- [ ] Substituted exercises: previousLog reflects the substitute's history (data is already correct from the API — no special frontend logic needed).

## Out of scope
- Aggregates (1RM, total volume, PR badges) — raw set data only.
- Editable or interactive previous log entries.
- Separate endpoint or lazy-load for previous performance.
- Trainer-facing session detail view (no `previousLog` on the trainer GET endpoint).

## Open design questions
- Should the "Última vez" section be collapsed by default on mobile (tap to expand) to preserve vertical space, or always visible below the prescription?
- How should the date be displayed — relative ("Há 7 dias") or absolute ("19 mai")? Or both?
- For exercises with many previous sets (e.g. 6 sets), should there be a "ver todos" truncation at 3?
- Should load be displayed in kg always, or should the unit be derived from the student's profile preference?
