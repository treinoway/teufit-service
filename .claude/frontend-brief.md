# Frontend Brief — Workouts Today: Multi-Protocol Support (treinoway-web)

**Backend branch**: staging · **Generated**: 2026-05-08 · **Target**: `treinoway-web` (React 19 SPA)

## Context for treinoway-web

`treinoway-web` does not currently consume `GET /my/workouts/today`. This brief documents the new contract so any future student-facing "Workout of the Day" screen (or any feature that surfaces today's training in the web app) implements it correctly from the start. No existing screen needs migration.

If/when this endpoint is wired into the web app, the consumer must follow the contract below — the response shape is an envelope, not a flat object.

## API contract — GET /my/workouts/today

- **Auth**: Bearer token (student role). Use the shared Axios instance at `src/api/axios.js` so token refresh + error normalization work automatically.
- **Headers**: `app-language` (`pt-BR` default; backend appends `*Label` siblings on categorical fields). `app-timezone` optional.
- **Success 200** envelope:
  ```json
  {
    "workouts": [
      {
        "protocol": {
          "id": "uuid",
          "name": "Hipertrofia",
          "startDate": "2025-01-01",
          "expirationDate": "2025-06-30"
        },
        "targetTraining": {
          "id": "uuid",
          "name": "Treino A - Peito e Tríceps",
          "category": "strength",
          "categoryLabel": "Força",
          "weekDay": "monday",
          "weekDayLabel": "Segunda-feira",
          "order": 0,
          "exercises": []
        },
        "isRestDay": false,
        "nextScheduledDate": null
      },
      {
        "protocol": { "id": "uuid", "name": "Mobilidade", "startDate": "2025-02-01", "expirationDate": null },
        "targetTraining": null,
        "isRestDay": true,
        "nextScheduledDate": "2025-05-10"
      }
    ],
    "pendingTraining": {
      "sessionId": "uuid",
      "trainingId": "uuid",
      "startedAt": "2025-05-08T10:00:00.000Z",
      "status": "in_progress",
      "statusLabel": "Em andamento"
    }
  }
  ```

  Invariants:
  - `pendingTraining` lives at envelope root — once per response, never inside entries.
  - `pendingTraining` is `null` when no in-progress session.
  - `targetTraining` is `null` on rest days.
  - `nextScheduledDate` is `null` on training days or when no future date computed.
  - `workouts` ordered by `protocol.startDate` desc.
  - Date-only fields (`startDate`, `expirationDate`, `nextScheduledDate`) are `"YYYY-MM-DD"` strings — do not pass to `new Date()` without timezone-safe parsing.

- **Errors** (Axios interceptor in `src/api/axios.js` will set `error.userMessage` from `messageCode`):
  - `401` · `UNAUTHORIZED` · `auth.unauthorized`
  - `404` · `NO_ACTIVE_PROTOCOL` · `workoutsToday.noActiveProtocol`
  - `404` · `EMPTY_PROTOCOL` · `workoutsToday.emptyProtocol`
  - `429` · `RATE_LIMIT_EXCEEDED` · `rateLimit.exceeded`
  - `500` · `INTERNAL_SERVER_ERROR` · `server.internalError`

## Cardinality rules for the consumer

1. Iterate `response.data.workouts` — do not read protocol/training/rest-day fields from the response root.
2. Read `response.data.pendingTraining` once at the top level to drive a resume banner — do not read it from inside workout entries.
3. Single-protocol case (most common) renders as one card. Multi-protocol is the rare case (e.g. strength + mobility from the same trainer); render one card per entry.
4. Rest-day entries should not show a "start workout" CTA; they show `nextScheduledDate` when non-null.

## i18n keys (treinoway-web `src/i18n/`)

Add to both `pt-BR.js` and `en-US.js` if/when this screen is built:

- `workoutsToday.noActiveProtocol` — "Você ainda não tem um protocolo ativo." / "You don't have an active training protocol yet."
- `workoutsToday.emptyProtocol` — "Seu protocolo ainda não tem treinos configurados." / "Your protocol has no trainings configured yet."

Categorical labels (`categoryLabel`, `weekDayLabel`, `statusLabel`) come pre-translated from the backend via the `app-language` header — display them directly, no client-side translation needed.

## Styling notes

Follow `treinoway-web/CLAUDE.md` Rule 2: all styling via `src/index.css` design tokens and component classes. No new CSS files, no Tailwind, no CSS modules.

## Acceptance criteria (when the screen is built)

- [ ] Consumer iterates `response.data.workouts`; never reads protocol/training fields from response root.
- [ ] Resume banner driven by `response.data.pendingTraining`, rendered at most once per screen.
- [ ] Single active protocol renders one card.
- [ ] Two active protocols render two cards ordered by `protocol.startDate` desc.
- [ ] Rest-day cards show `nextScheduledDate` when non-null; no start CTA.
- [ ] 404 `NO_ACTIVE_PROTOCOL` and `EMPTY_PROTOCOL` map to distinct empty states using the i18n keys above.
- [ ] Date-only fields rendered without timezone shift bugs (use `formatDateOnly`-equivalent parsing on the client).

## Out of scope for web

- Student dashboard (`student-dashboard-service`) `currentProtocol` field — still returns single most-recent protocol; not changed in this PR.
- Trainer branding resolution — unchanged.
- Workout session start/resume flow — separate feature.
