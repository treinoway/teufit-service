# Frontend Brief — Financeiro do treinador (reabertura)

**Backend branch**: master · **Generated**: 2026-10-05

## Elevator pitch
The trainer gets a reliable Financeiro page: one screen showing what was received, what is pending and what is overdue for a chosen month, with recurring charges created automatically and the same "overdue" number everywhere in the app (Home dashboard, Students list, Financeiro).

## User story
As a trainer, I want to see all my students' charges for a month in one place and register payments (even ones received days ago) so that I know exactly who owes me and my monthly revenue is correct.

## User flows
1. **Entry point**: sidebar "Financeiro" (link to be restored) and the overdue tile on the Home dashboard; per-student history from the student's row/menu.
2. **Happy path**:
   1. Trainer opens Financeiro; the page loads once (single request) for the current month.
   2. Sees 4 KPIs: Received in the month, To receive, Overdue, Delinquency rate.
   3. Sees rows grouped as Overdue / Pending / Paid (the API gives each row a status and days overdue).
   4. Row menu: Mark as paid (optional "paid on" date, not in the future), Revert to pending, Edit amount/due date (only while not paid), Void, View student history.
   5. Changes month with a month selector; the list and KPIs reload.
3. **Branches**:
   - Next recurring charge is created automatically ~7 days before the cycle starts. The old "add charge with free date" is replaced by "Generate next cycle" (no date picker); it may answer "not available yet".
   - Cancelling a plan, replacing a plan or unlinking a student voids charges that have not started yet; charges already due stay as debt and keep showing as overdue, even for cancelled subscriptions.
   - Student history page works even after the student was unlinked.

## UI states to cover
- Loading / Empty (no charges in the month) / Error / Success
- A charge is "overdue" only after 3 days of grace past its due date: show `effectiveStatus` + `daysOverdue` from the API; do NOT recompute status on the client (remove the cycle-end based derivation).
- Voided charges (`status: cancelled`) are not listed in the overview; they appear in the per-student history with a "Voided" badge.
- Rows of a cancelled subscription (`subscriptionStatus: cancelled`) can appear (debt) — show the plan as cancelled.
- Paid charge: amount and due date are locked (409) — disable those actions; notes stay editable.
- Permissions: 403 for non-trainers.
- KPI money values are strings ("1234.50") — format for display, never sum as floats on the client. `delinquencyRate` is a 0–100 number (percent of billed students that are overdue).
- "MRR" label no longer makes sense (annual plan paid in the month counts once as received); use "Received this month".

## API contract
### GET /trainer/finance/overview?month=YYYY-MM
- **Auth**: Bearer, role TRAINER. `month` optional (defaults to current month, America/Sao_Paulo).
- **Success** (200):
  ```json
  {
    "month": "2026-10",
    "overdueGraceDays": 3,
    "kpis": {
      "receivedAmount": "1200.00", "receivedCount": 12,
      "pendingAmount": "300.00", "pendingCount": 3,
      "overdueAmount": "199.80", "overdueCount": 2,
      "overdueStudents": 2, "billedStudents": 15, "delinquencyRate": 13.33
    },
    "payments": [{
      "id": "uuid", "subscriptionId": "uuid", "cycleIndex": 3,
      "cycleStartDate": "2026-10-01", "cycleEndDate": "2026-10-31", "dueDate": "2026-10-01",
      "amount": "99.90", "status": "pending", "statusLabel": "Pendente",
      "effectiveStatus": "overdue", "effectiveStatusLabel": "Em atraso", "daysOverdue": 4,
      "paidAt": null, "voidedAt": null, "notes": null,
      "subscriptionStatus": "active",
      "student": { "id": "uuid", "name": "Maria Silva", "avatarUrl": null },
      "plan": { "id": "uuid", "name": "Consultoria Mensal", "recurrence": "monthly" }
    }]
  }
  ```
  Row scope (explicit): (a) every pending payment with `dueDate` before the first day of the NEXT month — no lower bound, so older pending payments inside the grace window stay visible; (b) every payment overdue as of today, any month, including subscriptions already cancelled; (c) payments paid inside the requested month (São Paulo time). Voided payments are never listed.
- **Errors**: `400` · `VALIDATION_ERROR` · `validation.failed` · malformed `month`.

### GET /trainer/students/:studentId/payments
- **Auth**: TRAINER. No live link required (works after unlink).
- **Success** (200): `{ "student": { "id": "uuid", "name": "Maria Silva", "avatarUrl": null } /* null when the trainer has neither history nor a link with that id */, "summary": { "totalReceived": "598.80", "receivedCount": 6, "customerSince": "2026-01-31" }, "payments": [ same payment shape + "subscriptionStatus", "plan" ] }` (all subscriptions, newest cycle first, includes voided).

### POST /trainer/payments/:id/mark-paid
- **Request** (body optional): `{ "paidAt": "2026-10-02" }` — date only; not in the future and not earlier than 12 months before the subscription start. Voided payments can be paid too (late settlement). Paying an already paid payment is a no-op unless a *different* `paidAt` is sent (then 409, revert to pending first).
- **Success** (200): payment object.
- **Errors**: `400` · `SUBSCRIPTION_INVALID_PAID_AT` · `subscription.invalidPaidAt` · future date or too old; `409` · `SUBSCRIPTION_PAYMENT_ALREADY_PAID` · different `paidAt` on a paid payment; `409` · `SUBSCRIPTION_PAYMENT_CONFLICT` · `subscription.paymentConflict` · the payment was changed by another operation at the same time (refresh and retry).

### POST /trainer/payments/:id/mark-pending
- Reverting a paid payment returns it to `pending`, except a charge that was ever voided (manually, or by cancel/replace/unlink) and then paid late: that one returns to `cancelled`, not to debt. `409` · `SUBSCRIPTION_PAYMENT_CANCELLED` on a voided payment.

### POST /trainer/payments/:id/void  (DELETE /trainer/payments/:id is an alias returning 204)
- **Success** (200): payment with `status: "cancelled"`. Idempotent.
- **Errors**: `409` · `SUBSCRIPTION_PAYMENT_ALREADY_PAID` · `subscription.paymentAlreadyPaid` · payment is paid (revert to pending first).

### POST /trainer/subscriptions/:subscriptionId/payments  ("Generate next cycle")
- **Request**: `{ "dueDate"?: "YYYY-MM-DD", "notes"?: "string" }` — sending `cycleStartDate` is rejected with `400 VALIDATION_ERROR` — cycle dates always come from the subscription.
- **Success** (201): payment object.
- **Errors**: `409` · `SUBSCRIPTION_CANCELLED` · `subscription.cancelled`; `409` · `SUBSCRIPTION_CYCLE_NOT_DUE` · `subscription.cycleNotDue` · next cycle is more than 7 days ahead; `409` · `SUBSCRIPTION_CYCLE_ALREADY_EXISTS` · `subscription.cycleAlreadyExists` · the same cycle was created by a concurrent request; `400` · `VALIDATION_ERROR` · `cycleStartDate` sent.

### PATCH /trainer/payments/:id
- **Errors**: `409` · `SUBSCRIPTION_PAYMENT_ALREADY_PAID` · amount/dueDate change on a paid payment; `409` · `SUBSCRIPTION_PAYMENT_CANCELLED` · `subscription.paymentCancelled` · voided payment; `400` · `SUBSCRIPTION_INVALID_AMOUNT` · `subscription.invalidAmount` · more than 2 decimals or above 99,999,999.99.

### Other changed contracts
- Every payment object also has `voidedAt` (ISO timestamp or `null`) — set when the charge was voided (manually or by cancel/replace/unlink); it stays set if the voided charge is later paid.
- `GET /trainer/finance/overview` has top-level `overdueGraceDays` (currently 3) — use it for the "overdue after N days" copy instead of hardcoding.
- `GET /trainer/subscription-plans`: each plan has `activeSubscriptionCount` (integer, active subscriptions on that plan; list endpoint only).
- `discountPercent` (plan create/update, assign override) rejects more than 2 decimals with `400 SUBSCRIPTION_INVALID_AMOUNT`.
- Every payment object now has `cycleIndex`, `effectiveStatus` (`pending|paid|overdue|cancelled`) (+`effectiveStatusLabel`), `daysOverdue` (counted from the `dueDate`, not from the end of the grace period — a charge flagged overdue on day 4 shows `daysOverdue: 4`).
- `POST /trainer/students/:id/subscriptions`: new `409` · `SUBSCRIPTION_ALREADY_ACTIVE` · `subscription.alreadyActive` when another assignment for the same student is in flight (double click). A student can now have one active subscription per trainer (several trainers allowed). Assigning with a start date in the past bills ONLY the billing cycle that contains today (never a stale old cycle, never a burst of historical charges); `firstPayment.cycleStartDate` may therefore be earlier than today but later than the chosen start date. Replacing a plan: the replaced plan's pending charges starting on/after the new plan's first cycle are voided (so a period is never billed twice, even when both start the same day); every older charge of the old plan stays billable at full price. When the new plan starts in the future, the old plan keeps billing until then (its missing cycles starting before the new start are created at replacement time). No proration: an old cycle that started before the new start and overlaps it stays at full price — the trainer can edit its amount. Plan price/discount inputs now reject > 2 decimals (`SUBSCRIPTION_INVALID_AMOUNT`) and > 99,999,999.99 (400 validation).
- `POST /trainer/subscriptions/:id/cancel`: also voids not-yet-due pending payments; cancelling an already cancelled subscription (or racing with another cancel) returns `409 SUBSCRIPTION_CANNOT_EDIT_CANCELLED`.
- `GET /trainer/finance/overview` never fails because of cycle generation: if generation errors it is logged and existing data is returned.
- `GET /trainer/dashboard`: `finance.overdueCount/overdueAmount` and `plans.expiredCount` now use the 3-day grace rule and match the overview exactly. `plans.renewingSoonCount` is redefined: active subscriptions with a pending charge that is due soon or in its grace window, i.e. `dueDate` in [today − 3 days, today + 7 days] (not yet overdue). Together with `expiredCount` (overdue) every pending charge falls in exactly one bucket. `finance.monthReceived` uses the São Paulo month.
- Students list blocker `subscription_overdue` follows the same grace rule.

## i18n keys required
- `subscription.paymentAlreadyPaid` → "Esta cobrança já foi paga. Para alterá-la ou anulá-la, volte-a para pendente primeiro."
- `subscription.paymentCancelled` → "Esta cobrança foi anulada e não pode ser alterada."
- `subscription.cancelled` → "Esta assinatura está cancelada."
- `subscription.alreadyActive` → "Este aluno já possui uma assinatura ativa."
- `subscription.cycleNotDue` → "O próximo ciclo ainda não está disponível para cobrança."
- `subscription.invalidAmount` → "Valor inválido. Use até duas casas decimais e no máximo 99.999.999,99."
- `subscription.invalidPaidAt` → "Data de pagamento inválida: não pode ser futura nem anterior a um ano antes do início da assinatura."
- `subscription.paymentConflict` → "O pagamento foi alterado por outra operação. Atualize e tente novamente."
- `subscription.cycleAlreadyExists` → "Este ciclo de cobrança já existe."
- Status labels come from the API (`effectiveStatusLabel`): Pendente, Pago, Em atraso, Anulada.

## Acceptance criteria
- [ ] Financeiro loads with exactly one overview request (no per-student requests).
- [ ] Overdue count/amount on the Home dashboard equals the Financeiro "Overdue" KPI.
- [ ] A charge due today or within 3 days is shown as Pending, not Overdue.
- [ ] Trainer can mark a charge paid with a past date and it counts in that date's month.
- [ ] Paid charges cannot have amount/due date edited; the UI explains why.
- [ ] After cancelling a plan, future charges disappear from the overview and overdue ones remain.
- [ ] Student history is reachable after unlinking the student.

## Out of scope
- Prorating a plan change in the middle of a paid cycle (a new full charge is created; trainer edits the amount).
- Student account deletion effect on revenue history.
- Platform (Asaas) billing.

## Open design questions
- Where to place the month selector and whether to allow future months.
- Copy/placement for the "3 days grace" explanation next to the Overdue badge.
- How to present voided charges in the student history (strikethrough vs badge only).
- Whether "Generate next cycle" should be shown at all, given cycles are auto-generated (it only works within 7 days of the cycle start).
