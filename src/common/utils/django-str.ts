/**
 * Django's `str()` / `repr()`, for the values that reach the two columns Phase 9 step 6
 * converted from `hstore` to `jsonb`.
 *
 * ## Why this survived the codec's deletion
 *
 * The hstore *codec* — `parseHstore`, `formatHstore`, `decodePushSubscription`,
 * `decodeSchedulerPayload` — died with step 6: there is no hstore text to parse and no Python
 * repr to repair. This half did **not**, because it is not an encoding detail, it is the
 * **value rule** v1 had and the migrated data embodies.
 *
 * `HStoreField.get_prep_value` ran `str()` over every value on the way in, so
 * `{'endpoint': 123}` was stored as the string `'123'` and `POST /api/notification/subscribe`
 * with a non-string endpoint has always been a 200 that writes a coerced string. The dedupe
 * query compares against exactly that. Dropping the coercion would either 500 a request v1
 * answers, or store a JSON number the dedupe cannot match — so it stays, and the values v2
 * writes keep matching the 720 rows step 6 left behind.
 *
 * ⚠️ The nested-`repr` cases (a dict or a list under a non-native key) are kept for the same
 * reason and not because anything uses them today: a client can send
 * `{"endpoint": [1, 2]}`, v1 stores `'[1, 2]'`, and parity is the rule (§4 rule 2).
 */

/** Any value v1 could hand to Django's `HStoreField` — and now to a converted jsonb column. */
export type PythonEncodable =
  | string
  | number
  | bigint
  | boolean
  | null
  | undefined
  | readonly PythonEncodable[]
  | { readonly [key: string]: PythonEncodable };

const PYTHON_STRING_ESCAPES: Record<string, string> = {
  '\\': '\\\\',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

/**
 * Python's `repr()` for a `str`.
 *
 * CPython prefers single quotes, switching to double quotes only when the string contains
 * a single quote and no double quote.
 */
export function pythonReprString(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let out = '';
  for (const char of value) {
    if (char === quote) {
      out += `\\${char}`;
      continue;
    }
    const escape = PYTHON_STRING_ESCAPES[char];
    if (escape !== undefined) {
      out += escape;
      continue;
    }
    const code = char.codePointAt(0) as number;
    if (code < 0x20 || code === 0x7f) {
      out += `\\x${code.toString(16).padStart(2, '0')}`;
      continue;
    }
    out += char;
  }
  return `${quote}${out}${quote}`;
}

function pythonReprNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new TypeError(`Cannot encode non-finite number ${String(value)} into hstore`);
  }
  // Python renders a float with a `.0` suffix; an int has none. JavaScript has one numeric
  // type, so integral values are treated as Python ints - which is what v1 ever stores.
  return Number.isInteger(value) ? value.toFixed(0) : String(value);
}

/**
 * Python's `repr()`, for the values Django can put inside an hstore entry.
 * This is what produces the `{'p256dh': '...', 'auth': '...'}` form seen in the database.
 */
export function pythonRepr(value: PythonEncodable): string {
  if (value === null || value === undefined) {
    return 'None';
  }
  if (typeof value === 'string') {
    return pythonReprString(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'True' : 'False';
  }
  if (typeof value === 'number') {
    return pythonReprNumber(value);
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => pythonRepr(item as PythonEncodable)).join(', ')}]`;
  }
  const entries = Object.entries(value as Record<string, PythonEncodable>);
  return `{${entries.map(([key, item]) => `${pythonReprString(key)}: ${pythonRepr(item)}`).join(', ')}}`;
}

/**
 * Python's `str()` — identical to `repr()` except that a top-level string is returned
 * unquoted. This is the coercion Django's `HStoreField.get_prep_value` applies to every
 * value before writing.
 */
export function pythonStr(value: PythonEncodable): string {
  return typeof value === 'string' ? value : pythonRepr(value);
}
