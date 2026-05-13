---
name: Shared request schemas leak forbidden fields into specialized routes
description: When backend-engineer reuses a property block across endpoints, fields that are valid on one route silently pass validation on another where they should be rejected
type: feedback
---

When a single `*BodyProperties` const is spread into multiple route schemas, fields valid in route A become silently writable in route B where they violate invariants. The service layer must explicitly strip them, but often forgets.

**Why:** Real bug — `addSubstituteSchema` reused `exerciseBodyProperties` which includes `supersetGroupId`. The service validated a candidateMock with `supersetGroupId: null` (always passed), then spread the actual `data` into `buildExerciseData`, persisting the client-supplied `supersetGroupId` on a substitute row. Invariant "substitutes cannot be in supersets" silently violated.

**How to apply:** When a new route reuses a shared body schema, list every property it inherits and confirm the service either (a) explicitly strips the forbidden ones or (b) validates the actual inbound data, not a sanitized mock. Prefer dedicated `*BodyProperties` per route over reuse when the field set differs.
