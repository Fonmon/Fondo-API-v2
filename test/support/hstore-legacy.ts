import { pythonStr, type PythonEncodable } from '../../src/common/utils/django-str';

/**
 * **The v1 hstore encoding — test support only, retained on purpose.**
 *
 * Phase 9 step 6 (stage 2a) deleted `src/common/utils/hstore.codec.ts`: production reads and
 * writes `jsonb` now, and nothing in `src/` may speak hstore again.
 *
 * What still needs it is the **proof that the migration is correct**. Step 6 has not run in
 * production yet, so `test/step6-hstore-jsonb.e2e-spec.ts` builds hstore fixtures in a scratch
 * schema, runs the real migration files over them, and compares the decoded values — and the
 * decode has to be v1's, not the migration's own SQL, or the equality check would be scoring
 * the conversion against itself.
 *
 * ⚠️ So this file is **not** a leftover to delete in the next cleanup. It is deleted in
 * **stage 2b**, together with `prisma/migrations-step6` moving into `prisma/migrations` —
 * i.e. once step 6 has actually run in production and the migration no longer needs proving.
 *
 * Only the four pieces that suite uses were kept: {@link parseHstore}, {@link formatHstore} /
 * {@link toHstoreLiteral} for building fixtures, and {@link repairPythonReprToJson} for v1's
 * read-side quote repair. The Python `str()` coercion they need is **not** duplicated here —
 * it is imported from `src/common/utils/django-str.ts`, which survived step 6 because the
 * migrated data still embodies it.
 */

/** An hstore value as PostgreSQL stores it: a string, or SQL NULL. */
export type HstoreValue = string | null;

/** A decoded hstore column: ordered, string-valued. */
export type HstoreMap = Record<string, HstoreValue>;

// ---------------------------------------------------------------------------
// PostgreSQL hstore text format
// ---------------------------------------------------------------------------

/**
 * Parses the text rendering of an hstore column, i.e. the output of
 * `SELECT subscription::text FROM ...`.
 *
 * Insertion order is preserved exactly as PostgreSQL emitted it, which matters because v1
 * serialises the resulting object into the SQS message body.
 *
 * @throws SyntaxError when the input is not a well-formed hstore rendering.
 */
export function parseHstore(text: string): HstoreMap {
  const result: HstoreMap = {};
  let index = 0;

  const skipWhitespace = (): void => {
    while (index < text.length && /\s/.test(text[index])) {
      index += 1;
    }
  };

  const fail = (message: string): never => {
    throw new SyntaxError(`Malformed hstore at position ${index}: ${message}`);
  };

  const readToken = (): HstoreValue => {
    skipWhitespace();
    if (index >= text.length) {
      return fail('unexpected end of input');
    }
    if (text[index] === '"') {
      index += 1;
      let value = '';
      while (index < text.length) {
        const char = text[index];
        if (char === '\\') {
          const next = text[index + 1];
          if (next === undefined) {
            return fail('trailing backslash');
          }
          value += next;
          index += 2;
          continue;
        }
        if (char === '"') {
          index += 1;
          return value;
        }
        value += char;
        index += 1;
      }
      return fail('unterminated quoted string');
    }
    // Unquoted token. `hstore_out` never produces these except for NULL, but the input
    // format allows them.
    let raw = '';
    while (index < text.length && !/[\s,=]/.test(text[index])) {
      raw += text[index];
      index += 1;
    }
    if (raw.length === 0) {
      return fail('empty token');
    }
    return raw.toUpperCase() === 'NULL' ? null : raw;
  };

  skipWhitespace();
  if (index >= text.length) {
    return result;
  }

  for (;;) {
    const key = readToken();
    if (key === null) {
      fail('hstore keys cannot be NULL');
    }
    skipWhitespace();
    if (text.slice(index, index + 2) !== '=>') {
      fail('expected "=>"');
    }
    index += 2;
    result[key as string] = readToken();
    skipWhitespace();
    if (index >= text.length) {
      break;
    }
    if (text[index] !== ',') {
      fail('expected "," between entries');
    }
    index += 1;
  }

  return result;
}

function quoteHstoreToken(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Renders an {@link HstoreMap} in PostgreSQL's hstore text format, ready to be bound as a
 * parameter and cast: `INSERT ... VALUES ($1::hstore)`.
 *
 * The emitted key order is the object's own; PostgreSQL re-orders on storage, so it only
 * affects readability of the statement.
 */
export function formatHstore(map: HstoreMap): string {
  return Object.entries(map)
    .map(([key, value]) => {
      const renderedValue = value === null ? 'NULL' : quoteHstoreToken(value);
      return `${quoteHstoreToken(key)}=>${renderedValue}`;
    })
    .join(', ');
}

/**
 * Applies Django's `HStoreField.get_prep_value` coercion to a plain object, producing the
 * exact string map v1 would have written.
 *
 * `null` / `undefined` stay `null` (SQL NULL); everything else goes through
 * {@link pythonStr}. So `{ user_ids: [5] }` becomes `{ user_ids: '[5]' }` and
 * `{ keys: { auth: 'x' } }` becomes `{ keys: "{'auth': 'x'}" }`.
 */
export function encodeHstore(source: Record<string, PythonEncodable>): HstoreMap {
  const encoded: HstoreMap = {};
  for (const [key, value] of Object.entries(source)) {
    encoded[key] = value === null || value === undefined ? null : pythonStr(value);
  }
  return encoded;
}

/** `encodeHstore` + `formatHstore`: an object straight to a bindable hstore literal. */
export function toHstoreLiteral(source: Record<string, PythonEncodable>): string {
  return formatHstore(encodeHstore(source));
}

/**
 * v1's `subscription['keys'].replace("'", '"')`.
 *
 * Python replaces **all** occurrences. A naive JS `.replace("'", '"')` would replace only
 * the first and produce invalid JSON, so this helper exists to make the difference
 * impossible to get wrong by accident.
 *
 * It is a blunt textual substitution, exactly as in v1: a single quote appearing inside a
 * value would corrupt the result. No live row contains one (push-subscription keys are
 * base64url), and "fix" is Phase 9 work, not a porting decision.
 */
export function repairPythonReprToJson(reprText: string): string {
  return reprText.replaceAll("'", '"');
}
