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
