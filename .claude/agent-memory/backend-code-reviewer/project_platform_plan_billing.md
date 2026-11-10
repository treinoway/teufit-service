---
name: platform-plan-billing-invariants
description: Non-obvious billing invariants in platform plan / Asaas flows that reviewers keep needing (asaasSubscriptionId != paid, webhook never enforces cap on downgrade)
type: project
---

`platformSubscription.asaasSubscriptionId` is written by `createCheckout` BEFORE payment, so "has asaasSubscriptionId" does NOT mean "paid". Guards keyed on it (e.g. changeTier's no-paid-sub guard, BETA beta-plan 2026-10) still let an abandoned checkout self-upgrade via /change. Abandoned checkouts also go PAYMENT_OVERDUE -> PAST_DUE -> grace downgrade to FREE in `getTrainerPlan`, which demotes non-purchasable tiers (BETA, admin overrides).

`handlePaymentConfirmed` only reactivates on upgrade; it never calls `enforceStudentCapAfterDowngrade` when the paid tier is lower than the current one (e.g. BETA -> PRO conversion).

**Why:** found during beta-plan review (2026-10-26); these were pre-existing and amplified by new tiers.
**How to apply:** any change touching tiers, checkout, webhook or admin tier override — check abandoned-checkout and downgrade-via-webhook paths explicitly.
