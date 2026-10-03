# API Docs Sync — Agent Memory

## Postman Collection Conventions

- File: `postman/Treinoway.postman_collection.json`
- Collection-level variables: `{{baseUrl}}` (http://localhost:3000), `{{accessToken}}`, `{{refreshToken}}`
- Collection-level auth: `bearer` using `{{accessToken}}`
- **Response arrays**: mixed — many requests use `"response": []`, but simple GET-list endpoints in some folders (e.g. `Trainer` → "List Linked Students") DO include one inline `200 OK` example. When adding a new GET endpoint, check 1-2 sibling requests in the *same folder* first rather than assuming empty `response: []` — it varies by folder, not globally.
- Auth headers: **inconsistent across folders** — some (Import, Anamnesis - Copy) add `{"key": "Authorization", "value": "Bearer {{accessToken}}"}` explicitly; others (Trainer, Training Protocols - Trainer, AI Assistant) rely on collection-level bearer auth (`request.header: []`) and only set `Content-Type` on body requests. Follow the pattern of the nearest similar folder when adding new requests.
- Body requests always include `"options": {"raw": {"language": "json"}}` alongside `"mode": "raw"`.
- Disabled query params use `"value": null` (not empty string) and should always include a `"description"` field for clarity.
- **File formatting is 2-space JSON indentation, NOT tabs.** If editing the collection via a script (e.g. `json.load` + `json.dump`), use `indent=2, ensure_ascii=False`. Using `indent='\t'` reformats the entire ~19k-line file into a ~9000-line diff — always run `git diff --stat` after a scripted edit and confirm the diff is small/localized before considering the change done.
- `GET /trainer/briefing` (added alongside `trainer-briefing-route.js`) was **never added to Postman** — as of 2026-07-14 there is no "briefing" entry anywhere in the collection. If asked to mirror it, it doesn't exist; fall back to the nearest sibling GET in the `Trainer` folder (e.g. "List Linked Students") as the structural template instead, and flag the gap to the user.

## Folder Structure (Postman)

| Folder name | Route prefix | Auth |
|---|---|---|
| Health | / | none |
| Auth | /auth/* | none (per-request noauth) |
| User | /me, /become-trainer, /invite/preview (public), /invite/redeem | bearer (except /invite/preview) |
| Trainer | /trainer (profile, students, dashboard) | bearer + TRAINER role |
| Trainer Invites - Admin | /admin/trainer-invites | bearer + ADMIN |
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
- Swagger tags do NOT always match Postman folder names exactly (Diet folders are consolidated differently). Another confirmed case: `previewInviteSchema` and `redeemInviteSchema` both use `tags: ['Trainer Invites']`, but in Postman they live in the **`User`** folder (not a "Trainer Invites" folder — that name is reserved for the separate `Trainer Invites - Admin` folder, which covers the admin CRUD routes tagged `Trainer Invites - Admin`). When placing a new request, trust the physical location of its nearest sibling route (by URL prefix), not the Swagger tag name.
- Public (noauth) GET requests with a querystring — confirmed via `GET /invite/preview` (added 2026-09-28, `User` folder, positioned right before `Redeem Trainer Invite`): request-level `"auth": {"type": "noauth"}`, `"header": []` (no Content-Type, since GET has no body), `url.query[]` array with `key`/`value`/`description` per param. `originalRequest` in each response example omits the `auth` field entirely (confirmed against existing noauth examples like `Auth` → `Login`).

## i18n Array Field Example Convention (Postman)

- Confirmed pattern for `i18nArrayField()`-generated fields in Postman example bodies: plain array + `*Label` array of the **same length, same order**, values in pt-BR (collection examples are pt-BR by default) — e.g. `"roles": ["student"], "rolesLabel": ["Aluno"]` (the only pre-existing instance, in `User`/`Trainer` profile examples around line ~866-898 of the collection).
- As of 2026-07-15, `GET /trainer/students` (`List Linked Students` example, `Trainer` folder) is the second instance: added `ready` (boolean) + `blockers`/`blockersLabel` (`studentBlocker` categorical, from `src/constants/student-blocker.js`). Values: `no_active_protocol`/"Sem rotina ativa", `no_subscription`/"Sem plano", `subscription_cancelled`/"Plano cancelado", `subscription_overdue`/"Pagamento em atraso", `blocked_on_plan`/"Bloqueado pela sua cota". One example student shows `ready: true, blockers: [], blockersLabel: []`; the other shows two active blockers, to illustrate both states.
- `searchStudentsSchema` reuses the same `studentItemSchema` (including `ready`/`blockers`) but the service (`searchStudents`) does NOT actually populate those fields — the Postman "Search Linked Students" request has `"response": []` (no example), so this discrepancy doesn't surface there. If an example is ever added for search, don't copy `ready`/`blockers` values into it without checking the service first.

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

## Swagger — No Static Spec File

There is no checked-in `swagger.json`/`openapi.yaml` in this repo. Swagger/OpenAPI docs are generated fully dynamically at runtime by `@fastify/swagger` (registered in `api/server.js` ~line 238) from each route's inline `schema` property, then served via `@fastify/swagger-ui`. "Updating Swagger" for a new/changed route means: write a complete, well-formed `schema` object in the route file (or its `api/schemas/*.schema.js` companion) — there is no second artifact to hand-edit. Only `postman/Treinoway.postman_collection.json` is a static file requiring manual sync.

## Error Response Contract

All error responses must include `error`, `messageCode`, `message`, `details`. See `api/schemas/error-response.schema.js` for shared schemas (`errorResponseSchema`, `badRequestErrorResponseSchema`). The 409 Conflict response for start-session has a custom `conflictErrorSchema` with `details.activeSessionId`.

## URL Conventions

- Student self-service: `/my/*`
- Trainer actions on own data: `/trainer/*`
- Trainer actions on student data: `/trainer/students/:studentId/*`
- Nutritionist actions on own data: `/nutritionist/*`
- Nutritionist actions on patient data: `/nutritionist/patients/:patientId/*`
- Path params in Postman: `:paramName` format in raw URL, listed in `url.variable` array with key, value (empty string), description.
