# API Docs Sync — Agent Memory

## Postman Collection Conventions

- File: `postman/Treinoway.postman_collection.json`
- Collection-level variables: `{{baseUrl}}` (http://localhost:3000), `{{accessToken}}`, `{{refreshToken}}`
- Collection-level auth: `bearer` using `{{accessToken}}`
- **Response arrays**: almost all requests use `"response": []` — only the Refresh Token request has inline examples. Do NOT add example responses unless the endpoint is as complex as Refresh Token.
- Auth headers: **inconsistent across folders** — some (Import, Anamnesis - Copy) add `{"key": "Authorization", "value": "Bearer {{accessToken}}"}` explicitly; others (Training Protocols - Trainer, AI Assistant) rely on collection-level bearer auth and only set `Content-Type`. Follow the pattern of the nearest similar folder when adding new requests.
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
| Anamnesis - Trainer | /trainer/anamneses | bearer + TRAINER |
| Anamnesis - Sections | /trainer/anamneses/:id/sections | bearer + TRAINER |
| Anamnesis - Questions | /trainer/anamneses/:id/sections/:id/questions | bearer + TRAINER |
| Anamnesis - Student Linking | /trainer/students/:studentId/anamneses | bearer + TRAINER |
| Anamnesis - My | /my/anamneses | bearer |
| Anamnesis - Admin | /admin/anamneses | bearer + ADMIN role |
| Anamnesis - Copy | /trainer/anamneses/:id/copy | bearer + TRAINER |
| Import | /trainer/import/primecoaching | bearer + TRAINER |
| AI Assistant | /trainer/ai/chat | bearer + TRAINER |
| Diet - Foods | /foods, /food-groups | bearer (any role) |
| Diet - Nutritionist Patients | /nutritionist/patients | bearer + NUTRITIONIST |
| Diet - Protocol Templates | /nutritionist/diet-protocol-templates | bearer + NUTRITIONIST |
| Diet - Protocols | /nutritionist/diet-protocols, /my/diet-protocols | bearer + NUTRITIONIST / bearer |
| Diet - Meals | /nutritionist/diet-protocols/:protocolId/meals, /nutritionist/meals/:mealId | bearer + NUTRITIONIST |
| Diet - Food Items | /nutritionist/meals/:mealId/food-items, /nutritionist/food-items/:foodItemId | bearer + NUTRITIONIST |

## Swagger Tag Names

- `"Workout Sessions"` — all student workout session routes
- `"Workout Sessions - Trainer"` — all trainer-facing session routes
- `"AI Assistant"` — trainer AI chat route (`/trainer/ai/chat`)
- `"Foods"` — food catalog routes (`/foods`, `/food-groups`)
- `"Nutritionist - Patients"` — patient link/unlink and metabolic profile routes
- `"Diet Protocol Templates"` — template CRUD routes
- `"Diet Protocols - Nutritionist"` — nutritionist-facing protocol CRUD
- `"Diet Protocols - My"` — patient-facing protocol routes
- `"Diet Meals"` — meal CRUD within a protocol
- `"Diet Food Items"` — food item CRUD within a meal
- Swagger tags do NOT always match Postman folder names exactly (Diet folders are consolidated differently).

## Status Enum Values

- `WorkoutSessionStatus`: `in_progress`, `completed`, `abandoned`
- `ExerciseLogStatus`: `pending`, `completed`, `skipped`
- `DietProtocolStatus`: `active`, `completed`, `archived` — source: `src/constants/diet.js`
- `MealType`: `breakfast`, `lunch`, `dinner`, `morning_snack`, `afternoon_snack`, `supper`
- `DietType`: `standard`, `low_carb`, `high_protein`, `mediterranean`, `vegetarian`, `vegan`
- `GoalType`: `weight_loss`, `muscle_gain`, `maintenance`, `health`
- `TmbFormula`: `harris_benedict`, `mifflin_st_jeor`, `fao_who`, `cunningham`
- `ActivityLevel`: `sedentario`, `levemente_ativo`, `moderadamente_ativo`, `muito_ativo`, `extremamente_ativo`
- Source: `src/constants/training.js` (training), `src/constants/diet.js` (diet)

## Error Response Contract

All error responses must include `error`, `messageCode`, `message`, `details`. See `api/schemas/error-response.schema.js` for shared schemas (`errorResponseSchema`, `badRequestErrorResponseSchema`). The 409 Conflict response for start-session has a custom `conflictErrorSchema` with `details.activeSessionId`.

## URL Conventions

- Student self-service: `/my/*`
- Trainer actions on own data: `/trainer/*`
- Trainer actions on student data: `/trainer/students/:studentId/*`
- Nutritionist actions on own data: `/nutritionist/*`
- Nutritionist actions on patient data: `/nutritionist/patients/:patientId/*`
- Path params in Postman: `:paramName` format in raw URL, listed in `url.variable` array with key, value (empty string), description.
