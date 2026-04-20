# Frontend Brief — Nutritionist Profile

**Backend branch**: staging · **Generated**: 2026-04-19

## Elevator pitch
Users can now register as nutritionists, building a public profile (clinic name, CRN number, service mode) that appears in a discoverable listing — exactly the same UX pattern as the existing trainer profile.

## User story
As a user, I want to activate a nutritionist profile so that clients can find me and I can operate as a nutritionist within the platform.

## User flows

1. **Entry point**: Profile settings or role-selection screen — a "Become Nutritionist" CTA alongside the existing "Become Trainer" button.
2. **Happy path**:
   1. User taps "Become Nutritionist".
   2. App calls `PATCH /become-nutritionist` — receives new tokens with `nutritionist` role and `activeProfile: 'nutritionist'`.
   3. App stores new tokens, switches active profile to `nutritionist`.
   4. User is directed to the nutritionist onboarding form: professional document (CRN), clinic name, service mode, notes.
   5. User submits the form — app calls `PATCH /nutritionist`.
   6. Profile completion is determined automatically: when personal data (first name, last name, birth date, gender) and address (line1, city, state, postal code, country) are filled, `profileCompletedAt` is set.
   7. Completed profiles appear in `GET /nutritionists`.
3. **Branches**:
   - User already has `nutritionist` role: `PATCH /become-nutritionist` is idempotent — safe to call again.
   - User also has `trainer` role: both profiles coexist; the `activeProfile` preference determines which dashboard is shown.

## UI states to cover
- Loading / Empty / Error / Success for all three nutritionist endpoints.
- `profileCompletedAt: null` → show "complete your profile" nudge; non-null → show completed badge.
- `serviceMode: null` → display nothing or "not specified".
- `GET /nutritionists` empty array → "No nutritionists registered yet."
- Permissions: `PATCH /nutritionist` and `GET /nutritionist` return `403` if the user does not have the `nutritionist` role.

## API contract

### PATCH /become-nutritionist
- **Auth**: Bearer token required (any authenticated user)
- **Request**: no body
- **Success** (200):
  ```json
  {
    "activeProfile": "nutritionist",
    "token": { "accessToken": "<jwt>" },
    "refreshToken": "<token>"
  }
  ```
- **Errors**:
  - `401` · `UNAUTHORIZED` · `auth.unauthorized` · missing/expired token
  - `500` · `INTERNAL_SERVER_ERROR` · `internal.serverError` · unexpected failure

### PATCH /nutritionist
- **Auth**: Bearer token, `nutritionist` role required
- **Request**:
  ```json
  {
    "nutritionist": {
      "professionalDocument": "CRN-3 12345",
      "clinicName": "Clínica Saúde",
      "notes": "Especialista em nutrição esportiva",
      "serviceMode": "online"
    }
  }
  ```
  All fields optional. `serviceMode` must be `"online"`, `"in_person"`, or `"hybrid"`.
- **Success** (200): full nutritionist profile object (see GET /nutritionist)
- **Errors**:
  - `400` · `VALIDATION_ERROR` · `validation.failed` · invalid serviceMode or no body
  - `401` · `UNAUTHORIZED` · `auth.unauthorized` · not authenticated
  - `403` · `FORBIDDEN` · `auth.forbidden` · missing nutritionist role
  - `404` · `NOT_FOUND` · `nutritionist.notFound` · nutritionist record missing

### GET /nutritionist
- **Auth**: Bearer token, `nutritionist` role required
- **Success** (200):
  ```json
  {
    "id": "uuid",
    "firstName": "Ana",
    "lastName": "Silva",
    "birthDate": "1990-05-15",
    "avatarUrl": "https://...",
    "professionalDocument": "CRN-3 12345",
    "clinicName": "Clínica Saúde",
    "notes": "...",
    "serviceMode": "online",
    "serviceModeLabel": "Online",
    "profileCompletedAt": "2026-04-19T22:00:00Z",
    "address": { "city": "São Paulo", "state": "SP", ... },
    "socialNetworks": { "instagram": "...", ... },
    "createdAt": "2026-04-19T22:00:00Z"
  }
  ```
- **Errors**:
  - `403` · `FORBIDDEN` · `auth.forbidden` · missing nutritionist role
  - `404` · `NOT_FOUND` · `nutritionist.notFound` · profile not found

### GET /nutritionists
- **Auth**: Bearer token required (any authenticated user)
- **Success** (200): array of nutritionist items:
  ```json
  [
    {
      "id": "uuid",
      "firstName": "Ana",
      "lastName": "Silva",
      "avatarUrl": "https://...",
      "serviceMode": "online",
      "serviceModeLabel": "Online",
      "address": { "city": "São Paulo", "state": "SP", "country": "Brasil" },
      "socialNetworks": { "instagram": "..." }
    }
  ]
  ```
  Only nutritionists with `profileCompletedAt` set are returned.

## i18n keys required
- `nutritionist.notFound` → suggested copy: "Nutritionist profile not found."
- `trainerServiceMode.online` → "Online" (shared with trainer, already exists)
- `trainerServiceMode.in_person` → "In Person" (shared with trainer, already exists)
- `trainerServiceMode.hybrid` → "Hybrid" (shared with trainer, already exists)
- `userRole.nutritionist` → "Nutritionist" (new, added to locale files)

## Acceptance criteria
- [ ] "Become Nutritionist" flow grants the nutritionist role and issues new tokens.
- [ ] Nutritionist profile form shows `professionalDocument`, `clinicName`, `serviceMode`, `notes` fields.
- [ ] Profile completion nudge disappears once `profileCompletedAt` is set.
- [ ] Completed nutritionist profiles appear in the public listing.
- [ ] A user with the `trainer` role can also become a nutritionist — both profiles coexist.
- [ ] `serviceMode` is displayed using its translated label (`serviceModeLabel`).
- [ ] Users without the `nutritionist` role see `403` when accessing `/nutritionist` endpoints.

## Out of scope
- Nutritionist-specific student management (no student linking for nutritionists in this cycle).
- Nutritionist onboarding milestone tracking (`profileCompleted` flag only — no `firstStudentLinked` equivalent).
- Diet plan or meal management features.

## Open design questions
- Where should "Become Nutritionist" live: alongside "Become Trainer" on the same screen, or in a separate role-selection flow?
- Should the nutritionist dashboard share the same navigation structure as the trainer dashboard, or have its own?
- What icon/color scheme differentiates the nutritionist profile from the trainer profile?
- Should `clinicName` be labeled "Clínica" or "Local de atendimento"?
