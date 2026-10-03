---
name: user-relation-fanout-checklist
description: Enumerating User's relations for account deletion/anonymization — the four categories that get missed every time (professional profiles, SetNull FKs, invite rows, assignee protocols)
metadata:
  type: feedback
---

Any change that fans out over `User`'s relations (account deletion, anonymization, GDPR/LGPD export, "purge test users") must be cross-checked against `prisma/schema.prisma` with:

```
awk '/^model /{m=$2} /User[ ?]+@relation/{print NR": "m" :: "$0}' prisma/schema.prisma
```

`User` is the target of ~27 relations. The obvious `userId`-keyed ones (Address, SocialNetwork, UserPreferences, UserHealthDetail, RefreshToken, PasswordResetToken, Account, WorkoutSession, AiConversation) always get handled. The four categories that get missed:

1. **Professional profile rows** — `Trainer` (`professionalDocument` = CREF, `gymName`, `notes`) and `Nutritionist` (`professionalDocument`, `clinicName`, `notes`). Both `onDelete: Restrict`, both carry their own `deletedAt`, both hang the whole trainer content graph (TrainerBranding, PlatformSubscription billing, TrainerStudent rows keyed by `trainerId`, Video, Challenge, GamificationConfig) off them. A role-agnostic endpoint that ignores these leaves professional PII and live billing behind.
2. **`onDelete: SetNull` FKs** — `AiUsageEvent.studentId`, `AiInteractionLog.studentId`, `TrainerInvite.userId`. SetNull only fires on a *hard* row delete. In a soft-delete design it never fires, so these must be nulled explicitly. `AiInteractionLog` is the sharp one: its schema comment says outright that `userMessage`/`responseText` may contain student personal data.
3. **`TrainerInvite`** — retains the deleted user's `email` as plaintext, and `createInvite` (`src/services/trainer-invite-service.js`) rejects a new invite when an `ACCEPTED` row exists for that email, while `hasBetaAccess` (`src/helpers/beta-access.js`) matches by `userId`. Leaving the row behind locks a re-registering user out of the closed beta permanently.
4. **`assigneeId`-keyed protocols** — `TrainingProtocol.assigneeId` and `DietProtocol.assigneeId` (both `Restrict`). These are the user's actual program/diet content and are easy to mistake for trainer-owned data; `DietProtocol` is health data.

**Why:** the 2026-08-24 `DELETE /me` implementation handled 17 of 27 relations correctly (all `where`-clause field names right, including the `patientId`/`studentId` ones) but missed every item above.

**How to apply:** when reviewing, run the awk command and diff its output against the service's `tx.<model>` calls line by line. Also note the FK-violation worry is a red herring in this codebase's soft-delete design — `onDelete: Restrict` constrains `DELETE` only, and these flows end in an `UPDATE` that touches no FK column. Unhandled `Restrict` relations are a data-retention problem, never an atomicity one. Related: [[feedback_e2e_test_gap]], [[project_migration_drift_ai_logs]].
