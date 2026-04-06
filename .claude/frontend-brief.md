# Frontend Brief — Challenge-Scoped Gamification

**Backend branch**: staging · **Generated**: 2026-04-05

## Elevator pitch
Points, rankings, and bonuses are now exclusively tied to challenges — a student only earns points when enrolled in an active challenge. There is no longer a global leaderboard; every ranking is per-challenge.

## User story
As a student, I want to see my points and position within a specific challenge so that I know how I am performing against other participants in that competition.

As a trainer, I want to award bonus points to a student within a specific active challenge and view the leaderboard for that challenge so that I can manage each competition independently.

## User flows

### Student — view points and ranking for a challenge

1. **Entry point**: Student opens a challenge detail page (from "My Challenges" list).
2. **Happy path**:
   1. Student navigates to the challenge they want to check.
   2. The challenge detail page shows: their total points, position on the leaderboard, and point transaction history.
   3. Tapping "Ranking" shows the full leaderboard for that challenge with names, avatars, and point totals.
   4. Tapping "History" shows a paginated list of transactions (action type, points, date).
3. **Branches**:
   - If the student has zero points, show an empty state (not an error).
   - If the challenge is scheduled (not yet started), points and ranking may be shown as 0/empty with a "challenge has not started" note.
   - If the challenge is completed or cancelled, points and ranking are still visible (read-only).

### Trainer — award bonus points to a student in a challenge

1. **Entry point**: Trainer opens a challenge detail, selects a participant.
2. **Happy path**:
   1. Trainer opens the challenge detail page.
   2. Trainer selects a participant from the participant list.
   3. Trainer taps "Award bonus points".
   4. Modal appears: enter point amount and optional reason.
   5. On confirm, points are awarded and the participant's total updates.
3. **Branches**:
   - If the challenge is not ACTIVE (scheduled/completed/cancelled), the "Award bonus" button must be disabled with a tooltip explaining why.

### Deprecated flows to remove

- Any global ranking page or "Overall Ranking" tab must be removed. The backend returns 410 Gone for these endpoints.
- Any trainer bonus flow that does not involve selecting a challenge first must be removed.
- Any points history or summary screen that used `?trainerId=` must be updated to use `?challengeId=`.

## UI states to cover

- Loading / Empty / Error / Success
- Empty points: student has 0 points in a challenge — show 0 and empty history, not an error screen
- Inactive challenge: bonus award button disabled with tooltip when challenge status is not ACTIVE
- Null/absent data: student not enrolled in challenge → 404 with `student.notTrainee`
- Permissions: bonus award UI hidden for STUDENT role; trainer-only endpoints return 403 if called by student
- Gone endpoints (410): global ranking routes return 410 — remove the navigation entries rather than showing a generic error

## API contract

### GET /my/challenges
- **Auth**: student token required
- **Request**: optional `?trainerId=<uuid>&status=<active|scheduled|completed|cancelled>`
- **Success** (200): array of challenge objects, each including pts snapshot fields (`ptsWorkoutCompleted`, `ptsStreak7Days`, `ptsStreak30Days`, `ptsDailyCheckin`, `ptsEvolutionRecord`, `ptsWorkoutFeedback`, `dailyPointsCap`)

### GET /my/challenges/:id/ranking
- **Auth**: student token required
- **Success** (200):
  ```json
  {
    "entries": [
      { "position": 1, "studentId": "uuid", "firstName": "Ana", "lastName": "Silva", "avatarUrl": null, "points": 120 }
    ],
    "myPosition": 1,
    "myPoints": 120
  }
  ```
- **Errors**:
  - `403` · `CHALLENGE_FORBIDDEN_NOT_OWNER` · `challenge.forbidden.notOwner` · student not enrolled in this challenge
  - `404` · `CHALLENGE_NOT_FOUND` · `challenge.notFound` · challenge does not exist

### GET /my/points
- **Auth**: student token required
- **Request**: `?challengeId=<uuid>` (required)
- **Success** (200):
  ```json
  {
    "data": [{ "id": "uuid", "action": "WORKOUT_COMPLETED", "points": 10, "challengeId": "uuid", "createdAt": "2026-04-05T10:00:00.000Z" }],
    "total": 5,
    "page": 1,
    "limit": 20
  }
  ```
- **Errors**:
  - `400` · `VALIDATION_ERROR` · `validation.failed` · challengeId query param is missing
  - `404` · `STUDENT_NOT_TRAINEE` · `student.notTrainee` · student is not enrolled in this challenge

### GET /my/points/summary
- **Auth**: student token required
- **Request**: `?challengeId=<uuid>` (required)
- **Success** (200):
  ```json
  {
    "totalPoints": 75,
    "breakdown": {
      "WORKOUT_COMPLETED": 50,
      "DAILY_CHECKIN": 25
    }
  }
  ```
- **Errors**:
  - `400` · `VALIDATION_ERROR` · `validation.failed` · challengeId query param is missing
  - `404` · `STUDENT_NOT_TRAINEE` · `student.notTrainee` · student is not enrolled in this challenge

### POST /trainer/challenges/:challengeId/students/:studentId/bonus
- **Auth**: trainer token required
- **Request**:
  ```json
  { "points": 20, "reason": "Great performance this week" }
  ```
- **Success** (201):
  ```json
  { "id": "uuid", "studentId": "uuid", "points": 20, "action": "TRAINER_BONUS", "challengeId": "uuid", "reason": "Great performance this week", "createdAt": "2026-04-05T10:00:00.000Z" }
  ```
- **Errors**:
  - `400` · `CHALLENGE_NOT_ACTIVE` · `challenge.notActive` · challenge is not currently running
  - `404` · `NOT_FOUND` · `challenge.notFound` · challenge not found or not owned by this trainer
  - `404` · `NOT_FOUND` · `gamification.studentNotTrainee` · student not enrolled in this challenge

### GET /trainer/challenges/:id/ranking
- **Auth**: trainer token required
- **Success** (200): array of ranking entries (position, studentId, firstName, lastName, avatarUrl, points)
- **Errors**:
  - `404` · `NOT_FOUND` · `challenge.notFound`

### GET /trainer/students/:studentId/points
- **Auth**: trainer token required
- **Request**: `?challengeId=<uuid>` (required)
- **Success** (200): same paginated shape as GET /my/points
- **Errors**:
  - `400` · `VALIDATION_ERROR` · `validation.failed` · challengeId missing

### GET /trainer/ranking — GONE
- Returns `410 Gone` · `GLOBAL_RANKING_REMOVED` · `gamification.globalRankingRemoved`
- Remove this navigation item from the UI entirely.

### GET /my/ranking — GONE
- Returns `410 Gone` · `GLOBAL_RANKING_REMOVED` · `gamification.globalRankingRemoved`
- Remove this navigation item from the UI entirely.

## i18n keys required

- `challenge.notActive` → suggested copy: "This challenge is not active. Bonus points can only be awarded during an active challenge."
- `gamification.globalRankingRemoved` → suggested copy: "The global ranking has been removed. Rankings are now per-challenge."
- `student.notTrainee` → suggested copy: "You are not enrolled in this challenge."
- `gamification.studentNotTrainee` → suggested copy: "This student is not a participant in this challenge." (used on trainer-facing screens)
- `gamification.trainerProfileMissing` → suggested copy: "Trainer profile not found."

## Acceptance criteria

- [ ] Student can view their total points and position for a specific challenge from the challenge detail page.
- [ ] Student can view paginated point transaction history scoped to a specific challenge.
- [ ] Student can view a breakdown of points by action type for a specific challenge.
- [ ] Student can see the full leaderboard for a challenge they are enrolled in.
- [ ] Trainer can award bonus points to a student within an active challenge with an optional reason.
- [ ] Bonus award button is disabled (with tooltip) when the challenge status is not ACTIVE.
- [ ] Global ranking pages are removed from the app navigation.
- [ ] Points history and summary screens use `?challengeId=` instead of `?trainerId=`.
- [ ] A student with no points in a challenge sees 0 and an empty history, not an error.
- [ ] 410 responses from old ranking endpoints are handled gracefully (no unhandled error screen).

## Out of scope

- Push notifications for points awarded.
- Animated point counters or confetti on point award.
- Exporting challenge rankings as CSV.

## Open design questions

- Where in the challenge detail page should the ranking CTA live — as a tab, a button at the bottom, or an inline preview of the top 3?
- Should the student's own position be highlighted (e.g., pinned row) when they are not in the top 10?
- How should the "Award bonus" flow handle the reason field — is it displayed to the student afterward?
- Should historical challenge rankings (completed challenges) be accessible? If yes, what visual treatment distinguishes them from active ones?
- When `anonymousRanking: true` is set on the trainer's config, what should be shown — initials only, avatar removed, or both?
