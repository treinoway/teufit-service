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
