# Frontend Brief — Dashboard Timezone Support

**Backend branch**: staging · **Generated**: 2026-05-03

## Elevator pitch
The student-dashboard summary and daily-activity endpoints now bucket session dates in the student's local timezone rather than UTC, so a session logged at 22h on Wednesday in Brazil is counted on Wednesday — not Thursday — fixing incorrect streak counts and calendar grids for Brazilian users.

## User story
As a trainer, I want the student's daily activity calendar and streak count to reflect the student's actual local calendar days, so I can trust that the streak and heatmap accurately represent the student's consistency.

## User flows
1. **Entry point**: Trainer opens a student's dashboard (Student Profile → Activity / Dashboard tab)
2. **Happy path**:
   - App sends `app-timezone` header on the `/dashboard/summary` and `/dashboard/daily-activity` requests (e.g. `America/Sao_Paulo`)
   - Daily activity grid shows the correct local day for each session
   - Max streak count is computed from local-calendar days, not UTC days
3. **Branches**: If the header is omitted or invalid, the server silently falls back to `America/Sao_Paulo` — no error state is produced

## UI states to cover
- **No new visual states required** — the fix is transparent to rendered UI
- **Audit needed**: verify `app-timezone` is already included in dashboard requests; if not, add it using the device locale or user profile timezone
- **Fallback behavior**: missing or garbage `app-timezone` header → server uses `America/Sao_Paulo`, no error

## API contract

### GET /trainer/students/:studentId/dashboard/summary
- **Auth**: Bearer token, TRAINER role, student linked to trainer
- **New header**:
  - `app-timezone` (optional): IANA timezone string (e.g. `America/Sao_Paulo`). Defaults to `America/Sao_Paulo`.
- **Timezone effect**: `maxStreakDays` is computed from consecutive local-calendar dates, not UTC dates
- **Success** (200): unchanged shape — no new fields
- **Errors** (unchanged):
  - `400` · `INVALID_DATE_RANGE` · `dashboard.invalidDateRange`
  - `400` · `WINDOW_TOO_LARGE` · `dashboard.windowTooLarge`
  - `403` · wrong role or student not linked
  - `404` · student not found

### GET /trainer/students/:studentId/dashboard/daily-activity
- **Auth**: Bearer token, TRAINER role, student linked to trainer
- **New header**:
  - `app-timezone` (optional): IANA timezone string. Defaults to `America/Sao_Paulo`.
- **Timezone effect**: each row's `date` (YYYY-MM-DD) is now the local-calendar date in the provided timezone, not UTC date
- **Success** (200): unchanged shape — no new fields
- **Errors**: same as summary

### Other dashboard endpoints (unchanged)
`/dashboard/recent-sessions`, `/dashboard/exercise-progression`, `/dashboard/exercise-progression/:exerciseId` — no `app-timezone` support, return raw timestamps.

## i18n keys required
No new message codes introduced in this change.

## Acceptance criteria
- [ ] `app-timezone` header is sent on every `/dashboard/summary` and `/dashboard/daily-activity` request
- [ ] A session logged at 22:30 local time on day D appears under date D in the daily activity grid, not D+1
- [ ] The max streak counter correctly counts consecutive local-calendar days
- [ ] Omitting `app-timezone` produces the same result as sending `America/Sao_Paulo`
- [ ] Sending an invalid timezone string falls back gracefully — no 400 error

## Out of scope
- Trainer-side timezone preference setting
- Displaying the student's timezone label in the UI
- Any timezone handling for recent-sessions or exercise-progression views (those use raw timestamps)

## Open design questions
- Should `app-timezone` be derived from the device locale or a user profile setting? Product decision needed.
- If trainer and student are in different timezones, whose timezone should the heatmap use? (Backend currently uses whatever the client sends.)
