# API Docs Sync — Agent Memory

## Postman Collection Conventions

- File: `postman/Treinoway.postman_collection.json`
- Collection-level variables: `{{baseUrl}}` (http://localhost:3000), `{{accessToken}}`, `{{refreshToken}}`
- Collection-level auth: `bearer` using `{{accessToken}}`
- **Response arrays**: almost all requests use `"response": []` — only the Refresh Token request has inline examples. Do NOT add example responses unless the endpoint is as complex as Refresh Token.
- Auth headers: all protected routes add `{"key": "Authorization", "value": "Bearer {{accessToken}}"}` explicitly in the request headers even though collection-level bearer auth is set. This is the established pattern.
- Body requests always include `"options": {"raw": {"language": "json"}}` alongside `"mode": "raw"`.
- Disabled query params use `"value": null` (not empty string) and should always include a `"description"` field for clarity.

## Folder Structure (Postman)

| Folder name | Route prefix | Auth |
|---|---|---|
| Health | / | none |
| Auth | /auth/* | none (per-request noauth) |
| User | /me, /become-trainer | bearer |
| Trainer | /trainer (profile, students) | bearer + TRAINER role |
| Address | /postal-code | none |
| Training Protocols - Trainer | /trainer/protocols | bearer + TRAINER |
| Training Protocols - My | /my/protocols | bearer |
| Protocol Templates | /trainer/protocol-templates | bearer + TRAINER |
| Trainings - Trainer | /trainer/protocols/:id/trainings, /trainer/trainings/:id | bearer + TRAINER |
| Trainings - My | /my/protocols/:id/trainings, /my/trainings/:id | bearer |
| Training Templates | /trainer/training-templates | bearer + TRAINER |
| Exercise Templates | /trainer/exercise-templates | bearer + TRAINER |
| Exercises - Trainer | /trainer/trainings/:id/exercises, /trainer/exercises | bearer + TRAINER |
| Exercises - My | /my/trainings/:id/exercises, /my/exercises | bearer |
| Workout Sessions | /my/trainings/:id/workout-sessions, /my/workout-sessions | bearer |
| Workout Sessions - Trainer | /trainer/students/:studentId/workout-sessions | bearer + TRAINER |

## Swagger Tag Names

- `"Workout Sessions"` — all student workout session routes
- `"Workout Sessions - Trainer"` — all trainer-facing session routes
- These match the Postman folder names exactly.

## Status Enum Values

- `WorkoutSessionStatus`: `in_progress`, `completed`, `abandoned`
- `ExerciseLogStatus`: `pending`, `completed`, `skipped`
- Source: `src/constants/training.js`

## Error Response Contract

All error responses must include `error`, `messageCode`, `message`, `details`. See `api/schemas/error-response.schema.js` for shared schemas (`errorResponseSchema`, `badRequestErrorResponseSchema`). The 409 Conflict response for start-session has a custom `conflictErrorSchema` with `details.activeSessionId`.

## URL Conventions

- Student self-service: `/my/*`
- Trainer actions on own data: `/trainer/*`
- Trainer actions on student data: `/trainer/students/:studentId/*`
- Path params in Postman: `:paramName` format in raw URL, listed in `url.variable` array with key, value (empty string), description.
