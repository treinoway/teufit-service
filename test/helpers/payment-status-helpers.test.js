import { describe, it, expect } from 'vitest';
import {
  buildOverduePaymentWhere,
  deriveEffectiveStatus,
  overdueThreshold,
} from '../../src/helpers/payment-status-helpers.js';
import {
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
