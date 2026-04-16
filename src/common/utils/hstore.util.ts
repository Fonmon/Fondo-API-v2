/**
 * Convert a plain object to a PostgreSQL hstore literal string.
 * All values are coerced to strings (hstore only supports string values).
 * Example: { a: '1', b: 'hello' } → '"a"=>"1","b"=>"hello"'
 */
export function toHstoreLiteral(obj: Record<string, string>): string {
  return Object.entries(obj)
    .map(([k, v]) => `"${k}"=>"${v.replace(/"/g, '\\"')}"`)
    .join(',');
}

/**
 * Parse a PostgreSQL hstore string returned from a raw query into a plain object.
 * Example: '"a"=>"1","b"=>"hello"' → { a: '1', b: 'hello' }
 */
export function parseHstore(raw: string): Record<string, string> {
  if (!raw) return {};
  const result: Record<string, string> = {};
  const pattern = /"([^"]*)"=>"((?:[^"\\]|\\.)*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    result[match[1]] = match[2].replace(/\\"/g, '"');
  }
  return result;
}
