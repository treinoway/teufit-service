# Frontend Brief — Monthly Adherence With Concrete Numbers

**Backend branch**: staging · **Generated**: 2026-05-18

## Elevator pitch

Personal trainers can now see exactly how many sessions a student completed vs how many were expected this month — and whether that number improved or dropped compared to last month — in both the student roster and the individual student dashboard.

## User story

As a trainer, I want to see "6 of 8 sessions this month" and know whether that's better or worse than last month, so I can quickly identify students who are falling behind without needing to interpret raw percentages.

## User flows

1. **Entry point — roster list**: Trainer opens the student list (`/trainer/students`). Each student card now has enough data to render concrete session counts alongside the percentage.
2. **Happy path — student card**:
   1. Trainer sees each student card with adherence displayed as e.g. "6 de 8 treinos (75%)" for the current calendar month.
   2. The month label (e.g. "Maio") is derived from `adherenceMonth`.
   3. When `adherenceExpected` is null, the card shows only "–" or a neutral empty state (no active protocol).
3. **Entry point — student dashboard**: Trainer taps a student and opens their detail dashboard.
4. **Happy path — dashboard summary card**:
   1. Current-month adherence bar/number shows `adherenceCompleted` / `adherenceExpected` × 100 (= `adherence`).
   2. A delta badge compares `adherence` (current) vs `previousAdherence` (last month): "↑ +12%" or "↓ -8%" or "=" for no change, "–" when previous month has no data.
   3. `adherenceMonth` and `previousAdherenceMonth` label which months are being compared (e.g. "Maio vs Abril").
5. **Branches**:
   - Student has no active protocol: `adherence`, `adherenceCompleted`, `adherenceExpected` are all `null` → show "Sem protocolo ativo".
   - `previousAdherence` is null: render delta area as "Sem dados anteriores".
   - `adherence` = 100: celebrate with full bar / "100% 🎯" treatment.

## UI states to cover

- **Loading**: skeleton for both the roster card and the dashboard summary card.
- **Empty / null protocol**: `adherence === null` → neutral state, no bar, no delta.
- **Partial**: `adherenceCompleted < adherenceExpected` → bar fills proportionally to `adherence`.
- **Full**: `adherence === 100` → full bar, celebratory treatment.
- **No previous data**: `previousAdherence === null` → delta area hidden or "–".
- **Positive delta**: `adherence > previousAdherence` → green up-arrow badge.
- **Negative delta**: `adherence < previousAdherence` → red/orange down-arrow badge.
- **Neutral delta**: equal values → neutral badge or no badge.
- **Permissions**: roster and dashboard are trainer-only (403 for students).

## API contract

### GET /trainer/students

- **Auth**: Bearer token, TRAINER role required.
- **Request**: no body.
- **Success** (200):
  ```json
  [
    {
      "id": "uuid",
      "firstName": "Ana",
      "lastName": "Silva",
      "adherence": 75.0,
      "adherenceCompleted": 6,
      "adherenceExpected": 8,
      "adherenceMonth": "2026-05-01",
      "lastWorkoutAt": "2026-05-16T10:30:00.000Z",
      "currentPrLoad": 85.0,
      "currentPrAt": "2026-05-10T09:00:00.000Z"
    }
  ]
  ```
- **Errors**:
  - `401` · `UNAUTHORIZED` · `auth.unauthorized` · no token
  - `403` · `FORBIDDEN` · `auth.forbidden` · student calling a trainer route

### GET /trainer/students/:studentId/dashboard/summary

- **Auth**: Bearer token, TRAINER role required.
- **Request**: optional query params `dateFrom`, `dateTo` (only affect session counts, streaks, completionRate — NOT adherence).
- **Success** (200):
  ```json
  {
    "window": { "from": "...", "to": "..." },
    "sessionCounts": { "completed": 24, "in_progress": 1, "abandoned": 3 },
    "totalSessions": 28,
    "completionRate": 0.89,
    "adherence": 75.0,
    "adherenceCompleted": 6,
    "adherenceExpected": 8,
    "adherenceMonth": "2026-05-01",
    "previousAdherence": 62.5,
    "previousAdherenceMonth": "2026-04-01",
    "lastSessionAt": "2026-05-17T09:00:00.000Z",
    "currentProtocol": { "id": "uuid", "name": "Hypertrophy Block", "startDate": "2026-01-01", "expirationDate": "2026-06-30" },
    "maxStreakDays": 5,
    "sessionsPerWeek": 3.2,
    "daysSinceLastSession": 1
  }
  ```
  **Important**: `adherence`, `adherenceCompleted`, `adherenceExpected`, `adherenceMonth`, `previousAdherence`, and `previousAdherenceMonth` always reflect the calendar month — they do not change when the trainer changes `dateFrom`/`dateTo`. Only `sessionCounts`, `completionRate`, `totalSessions`, `sessionsPerWeek`, `maxStreakDays`, and `lastSessionAt` respond to the period filter.
- **Errors**:
  - `400` · `INVALID_DATE_RANGE` · `dashboard.invalidDateRange` · dateFrom > dateTo
  - `400` · `WINDOW_TOO_LARGE` · `dashboard.windowTooLarge` · window > 365 days
  - `404` · `STUDENT_NOT_FOUND` · `legacy.STUDENT_NOT_FOUND` · student not linked to trainer

## i18n keys required

- `dashboard.invalidDateRange` → suggested copy: "O período inicial não pode ser posterior ao final."
- `dashboard.windowTooLarge` → suggested copy: "O intervalo máximo permitido é de 365 dias."

New display strings (not messageCode — just UI copy decisions):
- Null adherence state: "Sem protocolo ativo"
- Previous month no data: "Sem dados anteriores"
- Delta positive: "↑ +{n}%"
- Delta negative: "↓ -{n}%"
- Month label format: use `adherenceMonth` ("2026-05-01") → derive "Maio 2026" / "May 2026" via `Intl.DateTimeFormat`.

## Acceptance criteria

- [ ] Student roster card displays `adherenceCompleted` / `adherenceExpected` (e.g. "6 de 8 sessões") alongside the percentage.
- [ ] Student roster card shows `adherenceMonth` formatted as a human-readable month name.
- [ ] When `adherenceExpected` is null, roster card shows a neutral/empty state (no bar, no count).
- [ ] Dashboard summary card shows current-month adherence as a progress bar or fraction using the same fields.
- [ ] Dashboard summary card shows a month-over-month delta badge using `previousAdherence`.
- [ ] Delta badge is hidden or neutral when `previousAdherence` is null.
- [ ] Changing the period picker (dateFrom/dateTo) does NOT change the adherence section — only session counts and streak change.
- [ ] The `adherenceMonth` and `previousAdherenceMonth` labels make clear which months are being compared.

## Out of scope

- `completionRate` display is unchanged.
- No changes to other dashboard KPIs (streak, sessionsPerWeek, daysSinceLastSession).
- Do not build a multi-month adherence trend chart (only current vs previous month delta).

## Open design questions

- Where exactly on the student card should the "6 de 8 sessões" text appear — below the adherence bar, inline with it, or as a tooltip?
- Should the delta badge on the dashboard show absolute percentage points (e.g. "+12pp") or relative change (e.g. "+19%")?
- What is the visual treatment when `adherence === 100`? Full bar with a check icon, confetti, nothing special?
- What month label format is preferred: "Maio" (short), "Maio 2026" (full), or "Mai/26" (compact for mobile)?
