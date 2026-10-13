import { describe, it, expect } from 'vitest';
import {
  buildDueSoonPaymentWhere,
  buildOverduePaymentWhere,
  deriveBillingStatus,
  deriveEffectiveStatus,
  overdueThreshold,
} from '../../src/helpers/payment-status-helpers.js';
import {
  BillingStatus,
  RENEWING_SOON_WINDOW_DAYS,
  EffectivePaymentStatus,
  PaymentStatus,
  PAYMENT_OVERDUE_GRACE_DAYS,
} from '../../src/constants/subscription.js';

const TODAY = new Date('2026-06-10T00:00:00Z');
const daysBeforeToday = (days) => new Date(TODAY.getTime() - days * 86400000);

describe('overdueThreshold', () => {
  it('is today minus the grace period', () => {
    expect(PAYMENT_OVERDUE_GRACE_DAYS).toBe(3);
    expect(overdueThreshold(TODAY)).toEqual(new Date('2026-06-07T00:00:00Z'));
  });
});

describe('buildOverduePaymentWhere', () => {
  it('matches pending payments with dueDate strictly before the threshold', () => {
    expect(buildOverduePaymentWhere(TODAY)).toEqual({
      status: PaymentStatus.PENDING,
      dueDate: { lt: new Date('2026-06-07T00:00:00Z') },
    });
  });
});

describe('deriveEffectiveStatus', () => {
  it('keeps a pending payment due today as pending', () => {
    expect(deriveEffectiveStatus({ status: PaymentStatus.PENDING, dueDate: TODAY }, TODAY)).toEqual({
      effectiveStatus: EffectivePaymentStatus.PENDING,
      daysOverdue: 0,
    });
  });

  it('keeps a pending payment due exactly today - 3 days as pending (still inside the grace window)', () => {
    const result = deriveEffectiveStatus(
      { status: PaymentStatus.PENDING, dueDate: daysBeforeToday(3) },
      TODAY,
    );

    expect(result.effectiveStatus).toBe(EffectivePaymentStatus.PENDING);
    expect(result.daysOverdue).toBe(0);
  });

  it('flags a pending payment due today - 4 days as overdue with daysOverdue 4', () => {
    const result = deriveEffectiveStatus(
      { status: PaymentStatus.PENDING, dueDate: daysBeforeToday(4) },
      TODAY,
    );

    expect(result).toEqual({ effectiveStatus: EffectivePaymentStatus.OVERDUE, daysOverdue: 4 });
  });

  it.each([
    ['2026-06-07T12:00:00Z', EffectivePaymentStatus.PENDING], // today - 3 stored at noon
    ['2026-06-06T12:00:00Z', EffectivePaymentStatus.OVERDUE], // today - 4 stored at noon
  ])('classifies a noon-UTC date-only value %s as %s', (dueDate, expected) => {
    const result = deriveEffectiveStatus(
      { status: PaymentStatus.PENDING, dueDate: new Date(dueDate) },
      TODAY,
    );

    expect(result.effectiveStatus).toBe(expected);
  });

  it('never marks paid payments overdue, however old', () => {
    const result = deriveEffectiveStatus(
      { status: PaymentStatus.PAID, dueDate: daysBeforeToday(90) },
      TODAY,
    );

    expect(result).toEqual({ effectiveStatus: EffectivePaymentStatus.PAID, daysOverdue: 0 });
  });

  it('never marks cancelled payments overdue', () => {
    const result = deriveEffectiveStatus(
      { status: PaymentStatus.CANCELLED, dueDate: daysBeforeToday(90) },
      TODAY,
    );

    expect(result).toEqual({ effectiveStatus: EffectivePaymentStatus.CANCELLED, daysOverdue: 0 });
  });
});

describe('buildDueSoonPaymentWhere', () => {
  it('matches pending payments due in [today - grace days, today + window days] inclusive', () => {
    expect(RENEWING_SOON_WINDOW_DAYS).toBe(7);
    expect(buildDueSoonPaymentWhere(TODAY)).toEqual({
      status: PaymentStatus.PENDING,
      dueDate: { gte: new Date('2026-06-07T00:00:00Z'), lte: new Date('2026-06-17T00:00:00Z') },
    });
  });

  it('includes today - 3 (lower bound) and excludes today - 4, which is overdue instead', () => {
    const { dueDate } = buildDueSoonPaymentWhere(TODAY);
    const overdue = buildOverduePaymentWhere(TODAY).dueDate;
    const inDueSoon = (d) => d >= dueDate.gte && d <= dueDate.lte;
    const inOverdue = (d) => d < overdue.lt;

    expect(inDueSoon(daysBeforeToday(3))).toBe(true);
    expect(inOverdue(daysBeforeToday(3))).toBe(false);
    expect(inDueSoon(daysBeforeToday(4))).toBe(false);
    expect(inOverdue(daysBeforeToday(4))).toBe(true);
  });

  it('includes today + 7 (upper bound) and excludes today + 8', () => {
    const { dueDate } = buildDueSoonPaymentWhere(TODAY);

    expect(dueDate.lte.getTime()).toBe(daysBeforeToday(-7).getTime());
    expect(daysBeforeToday(-8) <= dueDate.lte).toBe(false);
  });
});

describe('deriveBillingStatus', () => {
  const facts = (overrides) => ({
    hasActiveSubscription: true,
    hasOverduePayment: false,
    hasDueSoonPayment: false,
    ...overrides,
  });

  it('is none without an active subscription, even with overdue and due-soon payments', () => {
    expect(
      deriveBillingStatus(facts({ hasActiveSubscription: false, hasOverduePayment: true, hasDueSoonPayment: true })),
    ).toBe(BillingStatus.NONE);
  });

  it('is overdue when overdue wins over due soon', () => {
    expect(deriveBillingStatus(facts({ hasOverduePayment: true, hasDueSoonPayment: true }))).toBe(
      BillingStatus.OVERDUE,
    );
  });

  it('is due_soon when only a due-soon payment exists', () => {
    expect(deriveBillingStatus(facts({ hasDueSoonPayment: true }))).toBe(BillingStatus.DUE_SOON);
  });

  it('is ok for an active subscription with nothing pending in range', () => {
    expect(deriveBillingStatus(facts({}))).toBe(BillingStatus.OK);
  });
});
