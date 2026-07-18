---
name: Shared request schemas leak forbidden fields into specialized routes
description: When backend-engineer reuses a property block across endpoints, fields valid on one route silently pass validation on another (requests) or get advertised but never returned (responses)
type: feedback
---

When a single `*BodyProperties` const is spread into multiple route schemas, fields valid in route A become silently writable in route B where they violate invariants. The service layer must explicitly strip them, but often forgets.

**Why:** Real bug — `addSubstituteSchema` reused `exerciseBodyProperties` which includes `supersetGroupId`. The service validated a candidateMock with `supersetGroupId: null` (always passed), then spread the actual `data` into `buildExerciseData`, persisting the client-supplied `supersetGroupId` on a substitute row. Invariant "substitutes cannot be in supersets" silently violated.

**How to apply:** When a new route reuses a shared body schema, list every property it inherits and confirm the service either (a) explicitly strips the forbidden ones or (b) validates the actual inbound data, not a sanitized mock. Prefer dedicated `*BodyProperties` per route over reuse when the field set differs.

## Same trap on RESPONSE schemas: additive field advertised on routes that never populate it

Adding a field to a shared response schema silently adds it to the contract of *every* route reusing it. fast-json-stringify just omits the absent key, so nothing crashes and no test fails — but Swagger/Postman now promise a field the endpoint never returns, and a client doing `student.blockers.map(...)` gets a TypeError.

**Why:** Real finding — `studentItemSchema` (api/schemas/trainer-route.schema.js) is reused by three routes: `listStudentsSchema` (200), `searchStudentsSchema` (200), and `linkStudentSchema` (201, via `...studentItemSchema`). The `ready`/`blockers` feature only populated `listStudents`; the other two now advertise the fields and return nothing. Note the `x-i18n` dev guardrail does **not** catch this — `label-walker.js` `applyAtPath` has `if (!(fieldName in node)) return;`, so an absent annotated field is skipped silently.

**How to apply:** When a field is added to a response schema, grep the schema const name across the file — if it's referenced by more than one exported `*Schema`, every one of them is now part of the change. Either populate the field in all of them or split the schema (e.g. dedicated `studentListItemSchema`). `grep -n "<schemaConst>" api/schemas/*.js` takes seconds and this fanout is invisible in the diff.
