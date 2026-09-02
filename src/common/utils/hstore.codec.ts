/**
 * hstore codec — the string <-> object translation layer for the two `hstore` columns
 * (`fondo_api_notificationsubscriptions.subscription`,
 * `fondo_api_schedulertask.payload`).
 *
 * ## Why a codec at all
 *
 * Prisma models these columns as `Unsupported("hstore")` and its client can neither select
 * nor write them (prisma#19000). Every access therefore goes through raw SQL —
 * `SELECT subscription::text` on the way out, `$1::hstore` on the way in — confined to
 * `NotificationSubscriptionRepository` (Phase 2) and `SchedulerTaskRepository` (Phase 7).
 * This module is the pure part: no database, no Nest, no I/O.
 *
 * ## The quirks, and why they must be preserved
 *
 * hstore stores **strings only**. Django's `HStoreField.get_prep_value` runs `str()` over
 * every value before writing, so any non-string Python value lands in the database as its
 * Python `str()`/`repr()`:
 *
 * | v1 value | stored as |
 * |---|---|
 * | `payload['owner_id'] = 53` (int) | `"53"` |
 * | `payload['user_ids'] = [5]` (list) | `"[5]"` — happens to be valid JSON |
 * | `subscription['keys'] = {...}` (dict) | `"{'p256dh': '...', 'auth': '...'}"` — a Python repr, **not** JSON |
 * | `subscription['expirationTime'] = None` | SQL `NULL` |
 *
 * v1 reads them back with `json.loads(payload['user_ids'])` and
 * `json.loads(subscription['keys'].replace("'", '"'))`. Both are reproduced here verbatim.
 * **Do not "fix" them** — 94 subscription rows and 632 scheduler rows in the live database
 * are already encoded this way, and Phase 9 (hstore -> jsonb) is where the repair belongs.
 *
 * ⚠️ Two traps when porting the read path:
 *   1. Python's `str.replace(old, new)` replaces **every** occurrence; JavaScript's
 *      `String.prototype.replace` with a string pattern replaces only the first. Use
 *      {@link repairPythonReprToJson}, never a bare `.replace("'", '"')`.
 *   2. PostgreSQL emits hstore entries ordered by (key length, key bytes), and v1 feeds that
 *      dict straight into `json.dumps` for the SQS message body. Key order is therefore
 *      part of the wire format. {@link parseHstore} preserves the order it reads.
 */

/** An hstore value as PostgreSQL stores it: a string, or SQL NULL. */
export type HstoreValue = string | null;

/** A decoded hstore column: ordered, string-valued. */
export type HstoreMap = Record<string, HstoreValue>;

/** Any value v1 could hand to Django's `HStoreField`. */
export type PythonEncodable =
  | string
  | number
  | bigint
  | boolean
  | null
  | undefined
  | readonly PythonEncodable[]
  | { readonly [key: string]: PythonEncodable };

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

// ---------------------------------------------------------------------------
// Python str()/repr() emulation — the write path
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// v1 read-path quirks
// ---------------------------------------------------------------------------

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

/** A push subscription as the browser produced it and v1 republishes it to SQS. */
export interface PushSubscription {
  endpoint: string;
  expirationTime: string | null;
  keys: Record<string, string>;
  [extra: string]: unknown;
}

/**
 * Port of the decoding loop in `NotificationService.send_notification`:
 *
 * ```python
 * subscription = notification_subscription.subscription
 * subscription['keys'] = subscription['keys'].replace("'", '"')
 * subscription['keys'] = json.loads(subscription['keys'])
 * ```
 *
 * Every other entry is left as the string hstore returned it, `expirationTime` included
 * (it is SQL NULL in every live row and stays `null`). Key order is preserved so that
 * `JSON.stringify` reproduces v1's `json.dumps` byte for byte.
 */
export function decodePushSubscription(map: HstoreMap): PushSubscription {
  // ⚠️ Condition **C23**, review finding **S5**: v1 subscripts the key unconditionally, so a
  // row *without* it raises `KeyError` before anything is published. Checking the key's
  // presence up front — rather than only handling it if `Object.entries` yields it — is what
  // makes the absent case fail closed like v1's instead of publishing a subscription with no
  // `keys` field to the Lambda.
  requireHstoreKey(map, 'keys');

  const decoded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(map)) {
    if (key === 'keys') {
      if (value === null) {
        // Django stores Python `None` as SQL NULL; v1 then does `None.replace(...)`.
        throw new TypeError("AttributeError: 'NoneType' object has no attribute 'replace'");
      }
      decoded[key] = JSON.parse(repairPythonReprToJson(value)) as Record<string, string>;
      continue;
    }
    decoded[key] = value;
  }
  return decoded as unknown as PushSubscription;
}

/**
 * `map[key]` with Python's subscript semantics — condition **C23**, finding **S5**.
 *
 * v1 writes `subscription['keys']` and `payload['user_ids']` with no `in` check, so an hstore
 * row missing that key raises `KeyError` and the whole publish aborts. v2's decoders iterate
 * `Object.entries`, which visits only the keys that *are* present, so an absent key used to
 * decode to an object with the field simply missing — a fail-**open** divergence invisible to
 * any black-box round, because all 94 live rows carry both keys.
 *
 * The message shape matches `readEndpoint` in `notification.service.ts:143`, which is the
 * pattern the rest of the codebase uses for a ported `KeyError`.
 */
function requireHstoreKey(map: HstoreMap, key: string): void {
  if (!Object.prototype.hasOwnProperty.call(map, key)) {
    throw new Error(`KeyError: '${key}'`);
  }
}

/** A scheduler task payload after decoding. Only `user_ids` is not a string. */
export interface SchedulerPayload {
  type: string;
  owner_id: string;
  target: string;
  message: string;
  user_ids: number[];
  [extra: string]: unknown;
}

/**
 * Port of `NotificationExecuter.run`: `user_ids = json.loads(payload["user_ids"])`.
 * Every other entry stays a string — `owner_id` included, which is why the scheduler's
 * dedupe compares it as text.
 */
export function decodeSchedulerPayload(map: HstoreMap): SchedulerPayload {
  // Condition **C23** — same fail-closed rule as `decodePushSubscription`; Phase 7 inherits
  // this half when the executer starts reading `payload["user_ids"]`.
  requireHstoreKey(map, 'user_ids');

  const decoded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(map)) {
    if (key === 'user_ids') {
      if (value === null) {
        // v1: `json.loads(None)` -> TypeError, uncaught.
        throw new TypeError(
          'TypeError: the JSON object must be str, bytes or bytearray, not NoneType',
        );
      }
      decoded[key] = JSON.parse(value) as number[];
      continue;
    }
    decoded[key] = value;
  }
  return decoded as unknown as SchedulerPayload;
}
