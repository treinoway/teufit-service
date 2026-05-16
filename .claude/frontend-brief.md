# Frontend Brief — Trainer Briefing (SEUS ALUNOS AGORA)

**Backend branch**: staging · **Generated**: 2026-05-15

## Elevator pitch
Trainers can now see a live snapshot of their student cohort's key activity metrics — active students, returning students, stagnant progress, inactive students, and adherence rate — directly inside the AI assistant view, replacing the current mock data.

## User story
As a trainer, I want a real-time at-a-glance summary of my students' training activity so that I can quickly understand the health of my cohort before interacting with the AI assistant.

## User flows
1. **Entry point**: Trainer navigates to `/trainer/ai-assistant`. The "SEUS ALUNOS AGORA" card is already visible in the current UI (lines 567–594 of `AiAssistant.jsx`).
2. **Happy path**:
   1. Page loads → frontend calls `GET /trainer/briefing`.
   2. Response arrives → card populates with real numbers.
   3. If `adherenceDeltaPp` is positive, show an upward trend indicator; if negative, show a downward one; if zero, neutral.
3. **Branches**:
   - Fresh trainer with no students → all values are `0`; adherence shows `"0.00"`. No error state.
   - Token expired → 401 → redirect to login (existing auth interceptor handles this).
   - Trainer role missing → 403 → show generic permission error (existing error handling).

## UI states to cover
- **Loading**: Show skeleton loaders for each of the 6 metric tiles while the fetch is in flight.
- **Success**: Populate tiles with values from the response.
- **Error**: If the fetch fails (non-401/403), show a subtle inline error message within the card without breaking the rest of the AI assistant page.
- **Empty / fresh trainer**: All zeros are valid — do not show "no data" states. Zero is a legitimate value.
- **Permissions**: 403 → do not render the card; show a permission-denied notice.
- **Adherence delta sign**: `adherenceDeltaPp` is a string like `"4.00"` or `"-3.50"`. Parse as float to determine sign for the trend arrow/color.

## API contract
### GET /trainer/briefing
- **Auth**: Bearer token required (`TRAINER` role)
- **Request**: no body, no query params
- **Success** (200):
  ```json
  {
    "activeStudents": 24,
    "returningThisWeek": 2,
    "stagnantProgress": 3,
    "inactiveStudents": 2,
    "overallAdherence": "87.00",
    "adherenceDeltaPp": "4.00",
    "computedAt": "2026-05-15T22:00:00.000Z"
  }
  ```
- **Errors** (status · error · messageCode · when):
  - `401` · `UNAUTHORIZED` · `auth.unauthorized` · token missing or expired
  - `403` · `FORBIDDEN` · `auth.forbidden` · authenticated user is not a trainer
  - `404` · `NOT_FOUND` · `trainer.notFound` · trainer profile not found for this user
  - `500` · `INTERNAL_SERVER_ERROR` · `internal.serverError` · unexpected server failure

## i18n keys required
Stable messageCodes the frontend needs to translate for this feature:
- `trainer.notFound` → suggested copy: "Trainer profile not found"
- `auth.unauthorized` → already present in existing i18n
- `auth.forbidden` → already present in existing i18n

## Acceptance criteria
- [ ] Card renders real numbers from the API instead of hardcoded mock values.
- [ ] Each of the 6 metrics is displayed in its designated tile: active students, returning this week, stagnant progress, inactive students, overall adherence (%), adherence delta (pp).
- [ ] Loading state is visible while the fetch is in flight (skeleton or spinner per tile).
- [ ] `adherenceDeltaPp` drives a visual trend indicator: green/up for positive, red/down for negative, neutral for zero.
- [ ] A fresh trainer with no students sees all zeros, no error message.
- [ ] If the API returns 403, the card is hidden or shows a permission notice — does not crash the page.
- [ ] `computedAt` is optionally displayed as a "last updated" timestamp in a human-readable format.

## Open design questions
- Should `computedAt` be shown to the user ("Updated 2h ago"), hidden entirely, or surfaced only in a tooltip?
- Does `stagnantProgress` need a tooltip explaining what "stagnant" means (no new load PR in 14 days)?
- Visual weight of the trend arrow for `adherenceDeltaPp`: inline text (`+4pp`), coloured badge, or animated icon?
- Should the card have a manual refresh button, or is the read-on-load data enough?
