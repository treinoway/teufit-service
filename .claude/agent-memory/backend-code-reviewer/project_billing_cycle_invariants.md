---
name: billing-cycle-invariants
description: Subscription billing — void/cancel filters key on cycleStartDate; any change that lets dueDate differ from cycleStartDate (e.g. billingDay feature) must be checked against them
type: project
---

`cancelUpcomingPayments` (cancel, unlink, replace) decides "not yet due" by `cycleStartDate`, while overdue/renewing-soon/finance use `dueDate`. Historically dueDate == cycleStartDate, so this was safe.

**Why:** billing-day review (2026-10-26) found aligned cycle 0 can start before `startDate` (dueDate = startDate), so a not-yet-started subscription's first charge survives cancel/unlink/same-day re-assign -> student billed for a plan that never started, or double-billed on re-assign.

**How to apply:** whenever cycle math or dueDate rules change, grep every `cycleStartDate` filter in subscription-cycle-service / student-subscription-service / trainer-service unlink and test cancel-before-start and replace-before-start scenarios.
