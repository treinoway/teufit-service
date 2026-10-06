import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  computeCycleBounds,
  computeNextCycle,
  computeAmount,
  assertValidMoneyAmount,
  assertValidPercentage,
  formatPayment,
} from '../../src/helpers/subscription-helpers.js';
import { formatDateOnly } from '../../src/helpers/date-helpers.js';
import {
  EffectivePaymentStatus,
  PaymentStatus,
  SubscriptionErrorCode,
  SubscriptionMessageCode,
  SubscriptionRecurrence,
} from '../../src/constants/subscription.js';

const { Decimal } = Prisma;
const utc = (iso) => new Date(`${iso}T00:00:00Z`);

function boundsAsStrings(anchor, recurrence, index) {
  const { cycleStartDate, cycleEndDate } = computeCycleBounds(utc(anchor), recurrence, index);
  return [formatDateOnly(cycleStartDate), formatDateOnly(cycleEndDate)];
}

describe('computeCycleBounds', () => {
  describe('monthly with a Jan 31 anchor (non-leap 2026)', () => {
    it.each([
      [0, '2026-01-31', '2026-02-27'],
      [1, '2026-02-28', '2026-03-30'],
      [2, '2026-03-31', '2026-04-29'],
      [3, '2026-04-30', '2026-05-30'],
      [4, '2026-05-31', '2026-06-29'],
    ])('cycle %i => %s..%s (billing day returns to 31 when it exists)', (index, start, end) => {
      expect(boundsAsStrings('2026-01-31', SubscriptionRecurrence.MONTHLY, index)).toEqual([start, end]);
    });
  });

  describe('leap year', () => {
    it('Jan 31 2028 anchor: cycle 0 ends Feb 28 and cycle 1 starts Feb 29', () => {
      expect(boundsAsStrings('2028-01-31', SubscriptionRecurrence.MONTHLY, 0)).toEqual([
        '2028-01-31',
        '2028-02-28',
      ]);
      expect(boundsAsStrings('2028-01-31', SubscriptionRecurrence.MONTHLY, 1)).toEqual([
        '2028-02-29',
        '2028-03-30',
      ]);
    });
  });

  describe('annual with a Feb 29 anchor', () => {
    it('clamps to Feb 28 in non-leap years and returns to Feb 29 in the next leap year', () => {
      expect(boundsAsStrings('2028-02-29', SubscriptionRecurrence.ANNUAL, 0)).toEqual([
        '2028-02-29',
        '2029-02-27',
      ]);
      expect(boundsAsStrings('2028-02-29', SubscriptionRecurrence.ANNUAL, 1)).toEqual([
        '2029-02-28',
        '2030-02-27',
      ]);
      expect(boundsAsStrings('2028-02-29', SubscriptionRecurrence.ANNUAL, 4)).toEqual([
        '2032-02-29',
        '2033-02-27',
      ]);
    });
  });

  it.each([
    [SubscriptionRecurrence.QUARTERLY, '2026-01-01', '2026-03-31'],
    [SubscriptionRecurrence.SEMIANNUAL, '2026-01-01', '2026-06-30'],
    [SubscriptionRecurrence.ANNUAL, '2026-01-01', '2026-12-31'],
    [SubscriptionRecurrence.MONTHLY, '2026-05-01', '2026-05-31'],
  ])('%s cycle 0 from %s ends %s', (recurrence, anchor, end) => {
    expect(boundsAsStrings(anchor, recurrence, 0)[1]).toBe(end);
  });

  it('consecutive cycles are always contiguous (no gap, no overlap) for a month-end anchor', () => {
    const anchor = utc('2026-01-31');
    for (let index = 0; index < 24; index += 1) {
      const current = computeCycleBounds(anchor, SubscriptionRecurrence.MONTHLY, index);
      const next = computeCycleBounds(anchor, SubscriptionRecurrence.MONTHLY, index + 1);
      expect(next.cycleStartDate.getTime() - current.cycleEndDate.getTime()).toBe(86400000);
    }
  });
});

describe('computeNextCycle', () => {
  const subscription = { startDate: utc('2026-01-31'), recurrence: SubscriptionRecurrence.MONTHLY };

  it('returns cycle 0 anchored on startDate when there is no previous cycle', () => {
    const next = computeNextCycle(subscription, null);

    expect(next.cycleIndex).toBe(0);
    expect(formatDateOnly(next.cycleStartDate)).toBe('2026-01-31');
    expect(formatDateOnly(next.cycleEndDate)).toBe('2026-02-27');
  });

  it('follows the anchor grid so the Jan 31 billing day is preserved in March', () => {
    const afterCycle1 = computeNextCycle(subscription, {
      cycleIndex: 1,
      cycleEndDate: utc('2026-03-30'),
    });

    expect(afterCycle1.cycleIndex).toBe(2);
    expect(formatDateOnly(afterCycle1.cycleStartDate)).toBe('2026-03-31');
    expect(formatDateOnly(afterCycle1.cycleEndDate)).toBe('2026-04-29');
  });

  it('matches computeCycleBounds for every index when chaining from cycle 0', () => {
    let last = null;
    for (let index = 0; index < 14; index += 1) {
      const next = computeNextCycle(subscription, last);
      const grid = computeCycleBounds(subscription.startDate, subscription.recurrence, index);
      expect(next.cycleIndex).toBe(index);
      expect(next.cycleStartDate).toEqual(grid.cycleStartDate);
      expect(next.cycleEndDate).toEqual(grid.cycleEndDate);
      last = next;
    }
  });

  it('ignores the previous cycle end date: only lastCycle.cycleIndex matters (pure anchor grid)', () => {
    const next = computeNextCycle(subscription, { cycleIndex: 0, cycleEndDate: utc('2026-02-14') });

    expect(next.cycleIndex).toBe(1);
    expect(formatDateOnly(next.cycleStartDate)).toBe('2026-02-28');
    expect(formatDateOnly(next.cycleEndDate)).toBe('2026-03-30');
  });

  describe('with `today` (skips cycles that already ended)', () => {
    const backdated = { startDate: utc('2025-10-06'), recurrence: SubscriptionRecurrence.MONTHLY };

    it('jumps to the cycle containing today while keeping the grid index', () => {
      const next = computeNextCycle(backdated, null, utc('2026-10-06'));

      expect(next.cycleIndex).toBe(12);
      expect(formatDateOnly(next.cycleStartDate)).toBe('2026-10-06');
      expect(formatDateOnly(next.cycleEndDate)).toBe('2026-11-05');
    });

    it('keeps a cycle whose end date is exactly today', () => {
      const next = computeNextCycle(backdated, null, utc('2025-11-05'));

      expect(next.cycleIndex).toBe(0);
    });

    it('skips a cycle that ended yesterday', () => {
      const next = computeNextCycle(backdated, null, utc('2025-11-06'));

      expect(next.cycleIndex).toBe(1);
    });

    it('skips from last cycle index + 1 when the gap is wide', () => {
      const next = computeNextCycle(backdated, { cycleIndex: 0 }, utc('2026-04-20'));

      expect(next.cycleIndex).toBe(6);
      expect(formatDateOnly(next.cycleStartDate)).toBe('2026-04-06');
    });

    it('does not skip anything for a future subscription', () => {
      const future = { startDate: utc('2027-01-01'), recurrence: SubscriptionRecurrence.MONTHLY };

      expect(computeNextCycle(future, null, utc('2026-10-06')).cycleIndex).toBe(0);
    });
  });
});

describe('computeAmount', () => {
  it('rounds half-up to 2 places: 99.90 with 33.33% discount => 66.60', () => {
    expect(computeAmount(new Decimal('99.90'), new Decimal('33.33'), null).toFixed(2)).toBe('66.60');
  });

  it('rounds the exact midpoint up (0.01 less 50% => 0.005 => 0.01)', () => {
    expect(computeAmount(new Decimal('0.01'), new Decimal('50'), null).toFixed(2)).toBe('0.01');
  });

  it('rounds 33.33% of 100.01 correctly (66.6700...)', () => {
    expect(computeAmount(new Decimal('100.01'), new Decimal('33.33'), null).toFixed(2)).toBe('66.68');
  });

  it('prefers discountPercent over discountAmount when both are given', () => {
    expect(computeAmount(new Decimal('100'), new Decimal('10'), new Decimal('50')).toFixed(2)).toBe('90.00');
  });

  it('floors the net amount at zero', () => {
    expect(computeAmount(new Decimal('10'), null, new Decimal('50')).toFixed(2)).toBe('0.00');
  });

  it('returns a Decimal', () => {
    expect(computeAmount(new Decimal('10'), null, null)).toBeInstanceOf(Decimal);
  });

  it('accepts numeric / string inputs', () => {
    expect(computeAmount('19.99', 0, null).toFixed(2)).toBe('19.99');
  });
});

describe('assertValidMoneyAmount', () => {
  it.each([[undefined], [null], [0], [0.01], [10], ['10.50'], [99999999.99]])(
    'accepts %s',
    (value) => {
      expect(() => assertValidMoneyAmount(value)).not.toThrow();
    },
  );

  it.each([[0.001], [10.005], ['1.234'], [100000000], [99999999.995]])(
    'rejects %s with 400 SUBSCRIPTION_INVALID_AMOUNT',
    (value) => {
      expect(() => assertValidMoneyAmount(value)).toThrowError(
        expect.objectContaining({
          httpStatus: 400,
          error: SubscriptionErrorCode.INVALID_AMOUNT,
          messageCode: SubscriptionMessageCode.INVALID_AMOUNT,
        }),
      );
    },
  );
});

describe('assertValidPercentage', () => {
  it.each([[33.33], ['33.33'], [50], [0.01], [100]])('accepts %s', (value) => {
    expect(() => assertValidPercentage(value)).not.toThrow();
  });

  it.each([[null], [undefined]])('ignores %s', (value) => {
    expect(() => assertValidPercentage(value)).not.toThrow();
  });

  it.each([[33.333], ['33.333'], [0.001]])('rejects %s with SUBSCRIPTION_INVALID_AMOUNT (400)', (value) => {
    expect(() => assertValidPercentage(value)).toThrow(
      expect.objectContaining({
        httpStatus: 400,
        error: SubscriptionErrorCode.INVALID_AMOUNT,
        messageCode: SubscriptionMessageCode.INVALID_AMOUNT,
      }),
    );
  });
});

describe('formatPayment', () => {
  const today = utc('2026-06-10');
  const basePayment = {
    id: 'p1',
    subscriptionId: 's1',
    cycleIndex: 3,
    cycleStartDate: new Date('2026-06-01T12:00:00Z'),
    cycleEndDate: new Date('2026-06-30T12:00:00Z'),
    dueDate: new Date('2026-06-01T12:00:00Z'),
    amount: new Decimal('99.90'),
    status: PaymentStatus.PENDING,
    paidAt: null,
    notes: null,
    createdAt: new Date('2026-05-01T00:00:00Z'),
    updatedAt: null,
  };

  it('formats date-only fields as YYYY-MM-DD and the amount as a string', () => {
    const result = formatPayment(basePayment, today);

    expect(result).toMatchObject({
      cycleIndex: 3,
      cycleStartDate: '2026-06-01',
      cycleEndDate: '2026-06-30',
      dueDate: '2026-06-01',
      amount: '99.9',
    });
  });

  it('adds effectiveStatus overdue and daysOverdue for a pending payment past the grace window', () => {
    const result = formatPayment(basePayment, today);

    expect(result.status).toBe(PaymentStatus.PENDING);
    expect(result.effectiveStatus).toBe(EffectivePaymentStatus.OVERDUE);
    expect(result.daysOverdue).toBe(9);
  });

  it('reports daysOverdue 0 and the stored status for paid payments', () => {
    const result = formatPayment({ ...basePayment, status: PaymentStatus.PAID }, today);

    expect(result.effectiveStatus).toBe(EffectivePaymentStatus.PAID);
    expect(result.daysOverdue).toBe(0);
  });

  it('returns voidedAt null when the payment was never voided', () => {
    expect(formatPayment(basePayment, today).voidedAt).toBeNull();
  });

  it('returns voidedAt as stored when the payment was voided, even if later paid', () => {
    const voidedAt = new Date('2026-06-05T10:00:00Z');

    const result = formatPayment({ ...basePayment, status: PaymentStatus.PAID, voidedAt }, today);

    expect(result.voidedAt).toBe(voidedAt);
  });
});
