# Treinoway Service

## MUST FOLLOW RULES
- NEVER ignore CLAUDE.md. Always read and respect its content, this is not a suggestion.
- NEVER accept my plans or suggestions blindly. You MUST be skeptic and always try to find flaws or non-covered edge cases. Avoid Sycophancy.


## Error Handling

All error responses follow this contract — never deviate:

```json
{
  "error": "SOME_ERROR_CODE",
  "messageCode": "some.semantic.code",
  "message": "Human-readable fallback message",
  "details": {}
}
```

- Throw `AppError` (`src/errors/app-error.js`) from services/middlewares — never return ad-hoc payloads.
- Keep `messageCode` stable (used for client i18n).
- 5xx errors: never expose internals.
- Validation errors: `error: "VALIDATION_ERROR"`, `messageCode: "validation.failed"`, `details` array.
- Do not introduce legacy `error.code` / `error.statusCode` patterns.
- Route schemas (`api/schemas/`) must include `error`, `messageCode`, `message`, `details` in error responses.

## Date Handling

- **Date-only fields** (`birthDate`, `startDate`, `endDate`, any `@db.Date`): always format with `formatDateOnly()` from `src/helpers/date-helpers.js`. Returns `"YYYY-MM-DD"` string — prevents timezone shift bugs (e.g., Dec 18 becoming Dec 17 in UTC-3).
- **DateTime fields** (`createdAt`, `updatedAt`, etc.): keep as-is (ISO timestamp).

## Code Rules

- **Constants over loose strings**: Use named constants in `src/constants/` for error codes, roles, status values, and repeated string literals.
- **Dependency injection**: Services receive Prisma client and external clients as arguments — never import singletons inside business logic.
- **DRY with judgement**: Extract shared logic only when there are 3+ real usages.

## When Adding a New Field to a Model

Check ALL places where that model is created or copied — not just direct CRUD endpoints:

- `createFromTemplate` / import-from-template flows copy fields explicitly. New fields must be mapped manually.
- Any service that duplicates records or inherits from a template uses an intermediate data object — that object must include the new field.

Pattern for optional fields with template fallback:
```js
newField: data.newField !== undefined ? data.newField : template.newField,
```

## Required for Every New Route

- Update `postman/Treinoway.postman_collection.json`
- Swagger docs auto-generated from route JSON schemas — keep schemas complete

## Required for Every New Feature

- Unit tests for services/business logic (`test/services/`)
- E2E tests for API endpoints (`test/e2e/`)
