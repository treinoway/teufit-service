# Anamnesis Feature Improvements Changelog

## Overview

This document describes the changes introduced in the anamnesis feature improvement update.
Three areas were addressed: permission fixes, a versioning system via explicit forks, and
student response collection.

---

## Part 1: Permission Fixes

### `deleteAnamnesis` — Linked Guard

`DELETE /trainer/anamneses/:anamnesisId` now returns `409 ANAMNESIS_HAS_STUDENT_LINKS` if any
`StudentAnamnesis` record references the anamnesis. An anamnesis that has been distributed to
students must be forked before it can be deleted.

### Structural Mutation Guard

All operations that structurally modify an anamnesis (add/update/delete sections or questions,
reorder sections) now return `409 ANAMNESIS_HAS_STUDENT_LINKS` if the anamnesis is linked to
any student. Affected endpoints:

- `POST /trainer/anamneses/:anamnesisId/sections`
- `PATCH /trainer/anamneses/:anamnesisId/sections/reorder`
- `PATCH /trainer/anamneses/:anamnesisId/sections/:sectionId`
- `DELETE /trainer/anamneses/:anamnesisId/sections/:sectionId`
- `POST /trainer/anamneses/:anamnesisId/sections/:sectionId/questions`
- `PATCH .../questions/:questionId`
- `DELETE .../questions/:questionId`

The error response follows the unified contract:

```json
{
  "error": "ANAMNESIS_HAS_STUDENT_LINKS",
  "messageCode": "anamnesis.hasStudentLinks",
  "message": "This anamnesis is linked to students. Fork it first before editing.",
  "details": {}
}
```

**When to fork instead of edit:** If you need to modify an anamnesis that has already been
linked to students, use the fork endpoint to create a new version, then make edits on the fork.
The fork can then be linked to students independently.

---

## Part 2: Versioning — Explicit Fork Strategy

### New Database Fields (`anamneses` table)

| Field      | Type    | Default | Description                                      |
|------------|---------|---------|--------------------------------------------------|
| `version`  | integer | `1`     | Version number of this anamnesis                 |
| `parent_id`| UUID    | null    | References the anamnesis this was forked from    |

The `parent_id` carries a `RESTRICT` foreign key constraint — you cannot delete an anamnesis
that has been forked.

### New Endpoint: Fork Anamnesis

```
POST /trainer/anamneses/:anamnesisId/fork
Auth: Bearer token, TRAINER role required
```

Creates a deep copy of the anamnesis (all non-deleted sections, questions, and options).

**Response (201):**

```json
{
  "id": "new-uuid",
  "trainerId": "trainer-uuid",
  "title": "Same title as source",
  "description": "Same description as source",
  "isGeneral": false,
  "version": 2,
  "parentId": "source-uuid",
  "sections": [...],
  "createdAt": "...",
  "updatedAt": null
}
```

**Error responses:**

| Status | Error code | When |
|--------|------------|------|
| 403 | `FORBIDDEN_GENERAL_ANAMNESIS` / `anamnesis.forbidden.general` | Source is a general anamnesis |
| 403 | `FORBIDDEN_NOT_ANAMNESIS_OWNER` / `anamnesis.forbidden.notOwner` | Source belongs to another trainer |
| 404 | `ANAMNESIS_NOT_FOUND` / `anamnesis.notFound` | Anamnesis does not exist |

### Recommended Workflow

1. Trainer creates anamnesis (version 1)
2. Trainer links anamnesis to students
3. When structural changes are needed, trainer calls `POST /fork` to get version 2
4. Trainer edits version 2 freely (no students linked yet)
5. Trainer links version 2 to students as needed

---

## Part 3: Student Responses

### New Database Models

#### `anamnesis_responses`

Stores one response record per (anamnesis, student) pair. Unique constraint on
`(anamnesis_id, student_id)`.

| Field         | Type        | Description                                        |
|---------------|-------------|----------------------------------------------------|
| `id`          | UUID        | Primary key                                        |
| `anamnesis_id`| UUID        | FK → `anamneses.id` (RESTRICT)                    |
| `student_id`  | UUID        | FK → `users.id` (CASCADE on user delete)           |
| `submitted_at`| timestamptz | When the student last submitted                    |
| `created_at`  | timestamptz | Record creation time                               |
| `updated_at`  | timestamptz | Last updated                                       |

#### `anamnesis_answers`

Stores individual question answers for a response. Unique constraint on
`(response_id, question_id)`.

| Field        | Type   | Description                                         |
|--------------|--------|-----------------------------------------------------|
| `id`         | UUID   | Primary key                                         |
| `response_id`| UUID   | FK → `anamnesis_responses.id` (CASCADE)             |
| `question_id`| UUID   | FK → `anamnesis_questions.id` (RESTRICT)            |
| `value`      | JSON   | The student's answer — any JSON value is accepted   |
| `created_at` | timestamptz | Record creation time                           |
| `updated_at` | timestamptz | Last updated                                   |

### New Endpoints

#### Submit / Re-submit Response (Student)

```
POST /my/anamneses/:anamnesisId/response
Auth: Bearer token required
```

**Request body:**

```json
{
  "answers": [
    { "questionId": "uuid", "value": "yes" },
    { "questionId": "uuid", "value": 42 },
    { "questionId": "uuid", "value": ["option-a", "option-b"] }
  ]
}
```

`value` accepts any valid JSON — string, number, boolean, array, object.

On re-submission, all previous answers are deleted and replaced atomically.

**Response (200):** Full response object with `answers` array.

**Error responses:**

| Status | Error code | When |
|--------|------------|------|
| 400 | `VALIDATION_ERROR` / `validation.failed` | A `required: true` question has no answer; `details` contains array of `{ questionId, message }` |
| 404 | `ANAMNESIS_QUESTION_NOT_FOUND` / `anamnesis.question.notFound` | A submitted `questionId` does not exist in this anamnesis |
| 404 | `ANAMNESIS_NOT_LINKED_TO_STUDENT` / `anamnesis.notLinkedToStudent` | Anamnesis is not linked to the student's account |

#### Get My Response (Student)

```
GET /my/anamneses/:anamnesisId/response
Auth: Bearer token required
```

**Response (200):** Response object with `answers`.

**Error responses:**

| Status | Error code | When |
|--------|------------|------|
| 404 | `ANAMNESIS_NOT_LINKED_TO_STUDENT` / `anamnesis.notLinkedToStudent` | Anamnesis not linked to student |
| 404 | `ANAMNESIS_RESPONSE_NOT_FOUND` / `anamnesis.response.notFound` | Student has not submitted a response yet |

#### Get Student Response (Trainer)

```
GET /trainer/students/:studentId/anamneses/:anamnesisId/response
Auth: Bearer token, TRAINER role required
```

**Response (200):** Response object with `answers`.

**Error responses:**

| Status | Error code | When |
|--------|------------|------|
| 404 | `student.notFound` | Student is not linked to this trainer |
| 404 | `ANAMNESIS_NOT_LINKED_TO_STUDENT` / `anamnesis.notLinkedToStudent` | This trainer did not link this anamnesis to the student |
| 404 | `ANAMNESIS_RESPONSE_NOT_FOUND` / `anamnesis.response.notFound` | Student has not submitted a response yet |

### Response Object Shape

```json
{
  "id": "uuid",
  "anamnesisId": "uuid",
  "studentId": "uuid",
  "submittedAt": "2026-03-15T00:00:00.000Z",
  "createdAt": "2026-03-15T00:00:00.000Z",
  "updatedAt": null,
  "answers": [
    {
      "id": "uuid",
      "responseId": "uuid",
      "questionId": "uuid",
      "value": "yes",
      "createdAt": "...",
      "updatedAt": null
    }
  ]
}
```

### Trainer-Filled Responses (Trainer Fill + Student Confirmation)

The trainer can fill the anamnesis on behalf of a student who is present, then the student confirms it in the app.

| Endpoint | Auth | Notes |
|----------|------|-------|
| `GET /trainer/students/:studentId/anamneses/:anamnesisId/fill?studentPresent=true` | TRAINER | Returns `{ anamnesis, response \| null }`; `studentPresent=true` is the presence attestation (400 otherwise) |
| `PATCH /trainer/students/:studentId/anamneses/:anamnesisId/response/draft` | TRAINER | Same body/semantics as the student draft; does not change authorship |
| `POST /trainer/students/:studentId/anamneses/:anamnesisId/response` | TRAINER | Body `{ answers, attestation: { studentPresent: true } }`; stores `filledBy: "trainer"` and status `awaiting_confirmation` |
| `POST /my/anamneses/:anamnesisId/response/confirm` | Bearer | No body; `awaiting_confirmation` -> `submitted` (sets `studentConfirmedAt`) |

All response objects now also carry `filledBy` / `filledByLabel` (`student` \| `trainer`), `trainerAttestedAt` and `studentConfirmedAt`.
`status` is `draft` \| `awaiting_confirmation` \| `submitted`. `POST /my/anamneses/:anamnesisId/response` always produces a
student-authored, confirmed response (also when correcting a trainer-filled one). The trainer can re-finalize their own
submission but never overwrites one submitted by the student.

---

## New Error Codes Summary

| Error Code | Message Code | HTTP | Description |
|------------|-------------|------|-------------|
| `ANAMNESIS_HAS_STUDENT_LINKS` | `anamnesis.hasStudentLinks` | 409 | Anamnesis is linked to students; must fork before editing |
| `ANAMNESIS_RESPONSE_NOT_FOUND` | `anamnesis.response.notFound` | 404 | Student has not submitted a response |
| `ANAMNESIS_NOT_LINKED_TO_STUDENT` | `anamnesis.notLinkedToStudent` | 404 | Anamnesis is not linked to this student |
| `ANAMNESIS_RESPONSE_SUBMITTED_BY_STUDENT` | `anamnesis.response.submittedByStudent` | 409 | Trainer tried to finalize a response the student already submitted |
| `ANAMNESIS_RESPONSE_NOT_AWAITING_CONFIRMATION` | `anamnesis.response.notAwaitingConfirmation` | 409 | Student confirm called while the response is not `awaiting_confirmation` |

---

## Database Migrations Applied

1. `20260315000001_add_anamnesis_versioning` — Adds `version` and `parent_id` columns to `anamneses`
2. `20260315000002_add_anamnesis_responses` — Creates `anamnesis_responses` and `anamnesis_answers` tables

---

## Files Changed

| File | Change |
|------|--------|
| `prisma/schema.prisma` | Added `version`/`parentId`/`parent`/`forks`/`responses` to `Anamnesis`; added `answers` back-relation to `AnamnesisQuestion`; added `anamnesisResponses` to `User`; added `AnamnesisResponse` and `AnamnesisAnswer` models |
| `prisma/migrations/20260315000001_add_anamnesis_versioning/migration.sql` | New |
| `prisma/migrations/20260315000002_add_anamnesis_responses/migration.sql` | New |
| `src/constants/anamnesis.js` | Added 3 new error/message codes |
| `src/services/anamnesis-service.js` | Added `assertAnamnesisNotLinked` guard, guards on 8 functions, `forkAnamnesis`, `submitAnamnesisResponse`, `getMyAnamnesisResponse`, `getStudentAnamnesisResponse` |
| `api/schemas/anamnesis-route.schema.js` | Updated `anamnesisSchema`/`anamnesisListItemSchema` with `version`/`parentId`; added 409 to delete schema; added 4 new route schemas |
| `api/routes/anamnesis-route.js` | Added 4 new routes |
| `test/services/anamnesis-service.test.js` | Updated mocks, added 30 new unit tests |
| `test/e2e/anamnesis.e2e.test.js` | Added fork flow + response flow E2E test scenarios |
| `postman/Treinoway.postman_collection.json` | Added 4 new request entries |

---

## Part 4: Public Anamneses (Admin-Managed) + Copy

### Overview

Added full support for admin-managed public anamneses and a trainer-level copy operation.

### New Role: `admin`

`src/constants/roles.js` now exports `Roles.ADMIN = 'admin'`. Admin users are created by directly setting `roles: ['admin']` on the user record (no become-admin endpoint — this is a back-office operation).

### Admin CRUD for Public Anamneses

A new service (`src/services/admin-anamnesis-service.js`) and 12 routes under `/admin/anamneses` provide full lifecycle management of public anamneses:

- **No student-link guard**: Admins can add/update/delete sections and questions freely, even on linked anamneses. This is by design — admins maintain platform templates.
- **isGeneral always true**: All records created via these routes have `isGeneral: true`, `trainerId: null`.

Routes added:

| Method | Path |
|--------|------|
| POST | `/admin/anamneses` |
| GET | `/admin/anamneses` |
| GET | `/admin/anamneses/:id` |
| PATCH | `/admin/anamneses/:id` |
| DELETE | `/admin/anamneses/:id` |
| POST | `/admin/anamneses/:id/sections` |
| PATCH | `/admin/anamneses/:id/sections/reorder` |
| PATCH | `/admin/anamneses/:id/sections/:sectionId` |
| DELETE | `/admin/anamneses/:id/sections/:sectionId` |
| POST | `/admin/anamneses/:id/sections/:sectionId/questions` |
| PATCH | `/admin/anamneses/:id/sections/:sectionId/questions/:questionId` |
| DELETE | `/admin/anamneses/:id/sections/:sectionId/questions/:questionId` |

### Trainer Copy Endpoint

```
POST /trainer/anamneses/:anamnesisId/copy
Auth: Bearer token, TRAINER role required
```

Creates an independent private copy of an anamnesis. Works for public (`isGeneral: true`) anamneses or the trainer's own private ones. The copy always starts fresh: `parentId: null`, `version: 1`, `isGeneral: false`.

**Difference from fork:**
- **Fork** (`/fork`): Extends a version chain. New anamnesis has `version = source.version + 1`, `parentId = source.id`. Only works on trainer's own private anamneses. Use when evolving a linked anamnesis.
- **Copy** (`/copy`): Creates a completely independent record. `version: 1`, `parentId: null`. Works on public anamneses and own private ones. Use when getting a clean customizable template.

### New Files

| File | Description |
|------|-------------|
| `src/services/admin-anamnesis-service.js` | Admin-only service for public anamnesis CRUD |
| `api/schemas/admin-anamnesis-route.schema.js` | Route schemas for all 12 admin endpoints |
| `api/routes/admin-anamnesis-route.js` | Route registration for admin endpoints |
| `test/services/admin-anamnesis-service.test.js` | Unit tests for admin service |
| `test/e2e/admin-anamnesis.e2e.test.js` | E2E tests for admin routes |

### Modified Files

| File | Change |
|------|--------|
| `src/constants/roles.js` | Added `ADMIN: 'admin'` |
| `src/services/anamnesis-service.js` | Added `copyAnamnesis` function |
| `api/schemas/anamnesis-route.schema.js` | Added `copyAnamnesisSchema` |
| `api/routes/anamnesis-route.js` | Added `POST /trainer/anamneses/:id/copy` |
| `api/server.js` | Registered `adminAnamnesisRoutes` |
| `test/services/anamnesis-service.test.js` | Added `copyAnamnesis` tests |
| `test/e2e/anamnesis.e2e.test.js` | Added copy E2E tests |
| `postman/Treinoway.postman_collection.json` | Added 13 new requests + `adminToken` variable |
