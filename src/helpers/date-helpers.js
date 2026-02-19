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
