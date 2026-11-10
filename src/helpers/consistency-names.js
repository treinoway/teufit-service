/**
 * Short display names of students for the trainer's ranking screens.
 */

/**
 * Short name ("First L.") and initials of a student user; the initial comes from the last word of the last name.
 *
 * @param {{ firstName?: string|null, lastName?: string|null, username?: string|null }|null|undefined} user
 * @returns {{ displayName: string, initials: string }}
 */
export function shortNameOf(user) {
  const first = (user?.firstName ?? '').trim() || user?.username || '';
  const lastWord = (user?.lastName ?? '').trim().split(/\s+/).filter(Boolean).pop();
  const firstInitial = first.charAt(0).toUpperCase();
  if (!lastWord) return { displayName: first, initials: firstInitial };
  const lastInitial = lastWord.charAt(0).toUpperCase();
  return { displayName: `${first} ${lastInitial}.`, initials: `${firstInitial}${lastInitial}` };
}
