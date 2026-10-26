import { BUSINESS_TIMEZONE } from '../constants/subscription.js';

/**
 * Formats a Date object to a date-only string (YYYY-MM-DD).
 * Uses UTC methods to avoid timezone shifts.
 * 
 * @param {Date|string|null|undefined} date - Date to format
 * @returns {string|null} Date string in YYYY-MM-DD format, or null if input is falsy
 */
export function formatDateOnly(date) {
	if (!date) return null;
	const d = date instanceof Date ? date : new Date(date);
	const year = d.getUTCFullYear();
	const month = String(d.getUTCMonth() + 1).padStart(2, '0');
	const day = String(d.getUTCDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

/**
 * Parses YYYY-MM-DD strings to a stable UTC date instance.
 * Uses noon UTC to avoid day shifts when values cross timezones.
 *
 * @param {string|null|undefined} value
 * @returns {Date|null}
 */
export function parseDateOnlyAsUtc(value) {
	if (!value) return null;

	const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (dateOnlyMatch) {
		const year = Number(dateOnlyMatch[1]);
		const month = Number(dateOnlyMatch[2]);
		const day = Number(dateOnlyMatch[3]);
		return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
	}

	return new Date(value);
}

/**
 * Returns the weekday name (lowercase) for a given Date in the specified IANA timezone.
 * E.g. getWeekdayInTimeZone(new Date(), 'America/Sao_Paulo') → 'friday'
 *
 * @param {Date} date
 * @param {string} timeZone - IANA timezone string (e.g. 'America/Sao_Paulo')
 * @returns {string} Lowercase weekday name matching WeekDays constants
 */
export function getWeekdayInTimeZone(date, timeZone) {
	return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(date).toLowerCase();
}

/**
 * Returns a new Date that is N days ahead of the given date.
 * Safe for weekday arithmetic: the resulting instant's weekday is evaluated via Intl,
 * which handles DST boundaries correctly.
 *
 * @param {Date} date
 * @param {number} days - Number of days to add (must be positive)
 * @returns {Date}
 */
export function addDaysMs(date, days) {
	return new Date(date.getTime() + days * 86400000);
}

/**
 * Parses a YYYY-MM-DD string (or Date) to exactly midnight UTC.
 * Used for time-boundary calculations (ranking windows, challenge date fences)
 * where the precise start/end of a calendar day matters.
 *
 * Do NOT use this to store @db.Date fields — use parseDateOnlyAsUtc() for that.
 *
 * @param {string|Date|null|undefined} value
 * @returns {Date|null}
 */
export function getDateOnlyAsMidnightUtc(value) {
	if (!value) return null;

	if (value instanceof Date) {
		return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(), 0, 0, 0));
	}

	const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (dateOnlyMatch) {
		const year = Number(dateOnlyMatch[1]);
		const month = Number(dateOnlyMatch[2]);
		const day = Number(dateOnlyMatch[3]);
		return new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
	}

	// Fallback: parse and floor to midnight UTC
	const d = new Date(value);
	return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0));
}


const MS_PER_DAY = 86400000;

/**
 * Civil date (year, month, day) of an instant in the given IANA timezone.
 *
 * @param {Date} instant
 * @param {string} timeZone
 * @returns {{ year: number, month: number, day: number }} month is 1-12
 */
function civilDateInTimeZone(instant, timeZone) {
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).formatToParts(instant);
	const pick = (type) => Number(parts.find((part) => part.type === type).value);
	return { year: pick('year'), month: pick('month'), day: pick('day') };
}

/**
 * Offset (ms) of the timezone from UTC at the given instant (negative for UTC-3).
 */
function timeZoneOffsetMs(instant, timeZone) {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hourCycle: 'h23',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	}).formatToParts(instant);
	const pick = (type) => Number(parts.find((part) => part.type === type).value);
	const asIfUtc = Date.UTC(pick('year'), pick('month') - 1, pick('day'), pick('hour'), pick('minute'), pick('second'));
	return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * Instant at which the wall clock in `timeZone` reads the given civil date/time.
 *
 * @param {{ year: number, month: number, day: number }} civil - month is 1-12
 * @param {string} timeZone
 * @param {number} [hour]
 * @returns {Date}
 */
export function zonedWallClockToInstant({ year, month, day }, timeZone, hour = 0) {
	const naiveUtc = Date.UTC(year, month - 1, day, hour, 0, 0);
	const firstGuess = naiveUtc - timeZoneOffsetMs(new Date(naiveUtc), timeZone);
	// Second pass settles the offset when the guess crosses a DST transition.
	return new Date(naiveUtc - timeZoneOffsetMs(new Date(firstGuess), timeZone));
}

/**
 * The civil "today" in the business timezone, as a Date at midnight UTC
 * (the shape Prisma uses for @db.Date comparisons).
 * E.g. 23:30 in America/Sao_Paulo is still the same civil day, even though
 * UTC has already rolled over to the next one.
 *
 * @param {Date} [now]
 * @param {string} [timeZone]
 * @returns {Date}
 */
export function todayInBusinessTz(now = new Date(), timeZone = BUSINESS_TIMEZONE) {
	// `null` (e.g. a missing timestamp) must not silently resolve to the 1970 epoch.
	const { year, month, day } = civilDateInTimeZone(now ?? new Date(), timeZone);
	return new Date(Date.UTC(year, month - 1, day));
}

/**
 * [start, end) instants of a calendar month ("YYYY-MM") in the business
 * timezone — for filtering timestamptz columns such as paidAt.
 *
 * @param {string} yearMonth - "YYYY-MM"
 * @param {string} [timeZone]
 * @returns {{ start: Date, end: Date }}
 */
export function monthWindowInBusinessTz(yearMonth, timeZone = BUSINESS_TIMEZONE) {
	const [year, month] = yearMonth.split('-').map(Number);
	const nextMonthYear = month === 12 ? year + 1 : year;
	const nextMonth = month === 12 ? 1 : month + 1;
	return {
		start: zonedWallClockToInstant({ year, month, day: 1 }, timeZone),
		end: zonedWallClockToInstant({ year: nextMonthYear, month: nextMonth, day: 1 }, timeZone),
	};
}

/**
 * "YYYY-MM" of the civil month containing `now` in the business timezone.
 */
export function currentYearMonthInBusinessTz(now = new Date(), timeZone = BUSINESS_TIMEZONE) {
	const { year, month } = civilDateInTimeZone(now, timeZone);
	return `${year}-${String(month).padStart(2, '0')}`;
}

/**
 * First day of the month after `yearMonth`, as midnight UTC (date-only boundary).
 */
export function firstDayOfNextMonthUtc(yearMonth) {
	const [year, month] = yearMonth.split('-').map(Number);
	return new Date(Date.UTC(year, month, 1));
}

/**
 * Adds calendar months to a date-only value, clamping to the last day of the
 * target month (Jan 31 + 1 month → Feb 28/29). Always computed from the
 * original anchor by callers so the billing day never drifts.
 *
 * @param {Date} date
 * @param {number} months
 * @returns {Date} midnight UTC
 */
export function addMonthsClamped(date, months) {
	const day = date.getUTCDate();
	const targetMonthIndex = date.getUTCMonth() + months;
	const lastDayOfTargetMonth = new Date(Date.UTC(date.getUTCFullYear(), targetMonthIndex + 1, 0)).getUTCDate();
	return new Date(Date.UTC(date.getUTCFullYear(), targetMonthIndex, Math.min(day, lastDayOfTargetMonth)));
}

/**
 * Date-only value for `day` of the given month, clamped to the month length.
 *
 * @returns {Date} midnight UTC
 */
export function dateWithClampedDay(year, monthIndex, day) {
	const lastDayOfMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
	return new Date(Date.UTC(year, monthIndex, Math.min(day, lastDayOfMonth)));
}

/**
 * Whole days between two midnight-UTC dates (later - earlier).
 */
export function diffInDays(later, earlier) {
	return Math.round((later.getTime() - earlier.getTime()) / MS_PER_DAY);
}
