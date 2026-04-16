const formatter = new Intl.DateTimeFormat('es', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/**
 * Format a date using Spanish locale abbreviations.
 * CLDR data specifies that Spanish abbreviated months end with a period (e.g. "nov.").
 * Node.js ICU omits the period, so we append it to the month part.
 */
function parseLocalDate(str: string): Date {
  const [year, month, day] = str.split('-').map(Number);
  return new Date(year, month - 1, day);
}

export function formatDateEs(date: Date | string): string {
  const d = typeof date === 'string' ? parseLocalDate(date) : date;
  const parts = formatter.formatToParts(d);
  return parts
    .map(({ type, value }) => (type === 'month' ? `${value}.` : value))
    .join('');
}
