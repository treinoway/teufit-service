# Tech Debts

## Gamification — Challenge-Scoped Refactor

### 1. Undo bonus is visual-only (no backend support)
The frontend shows an undo toast (3s window) after awarding bonus points, but there is no backend endpoint to reverse a bonus transaction. The toast currently displays "Bonus desfeito" without actually deleting anything.

**Action needed:** Create `DELETE /trainer/challenges/:challengeId/bonus/:bonusId` endpoint that allows reversing a bonus within a short TTL window (e.g., 30s after creation). The frontend already has the UndoToast component wired up — just needs a real API call.

### 2. English locale not updated
Only `pt-BR.js` was updated with the new gamification/challenge i18n keys. The `en.js` locale file is missing all new keys added in this feature.

**Action needed:** Mirror all new keys from `pt-BR.js` into `en.js` with English translations.

### 3. StudentPoints.jsx kept despite model change
The spec called for deleting `StudentPoints.jsx` (`/trainer/students/:studentId/points`), but it's still used from the trainer's student detail page. The route now requires `?challengeId=` but the student detail page navigates to it without a challenge context.

**Action needed:** Either update the student detail page to navigate to points within a specific challenge, or replace the link with a list of challenges the student participates in (each linking to challenge-scoped points).

### 4. Bulk bonus endpoint does not exist
The frontend bulk selection mode on the Participantes tab fires N sequential `POST /trainer/challenges/:challengeId/students/:studentId/bonus` calls via `Promise.all`. If one fails, the user sees a partial success with no clear indication of which students failed.

**Action needed:** Create `POST /trainer/challenges/:challengeId/bonus/bulk` with body `{ studentIds: [], points, reason? }` that handles the batch atomically.

### 5. Delta arrows in ranking rows (no data source)
The design spec calls for delta arrows showing rank changes vs. previous period. The backend does not return previous-period position data, so there is no source for deltas.

**Action needed:** Either add `previousPosition` to the ranking endpoint response, or drop this from the design.

### 6. Student aggregate summary endpoint missing
The `AggregateSummaryCard` on the student challenge list shows total points + best rank across all challenges. Currently this is computed client-side from the challenge list response. There is no dedicated backend endpoint.

**Action needed:** If performance becomes an issue with many challenges, create `GET /my/challenges/summary` returning `{ totalPoints, bestRank: { position, challengeName, challengeId } }`.
