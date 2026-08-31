/**
 * CPython `json.dumps` — the **serialising** half of the Python-JSON emulation
 * (`src/common/http/python-json.ts` covers the parse-error half).
 *
 * ## Why this exists
 *
 * v1 publishes web-push notifications to SQS with
 *
 * ```python
 * sqs_client.send_message(QueueUrl=queue_url, MessageBody=json.dumps(message['content']))
 * ```
 *
 * (`fondo_api/celery/tasks.py:19`). The plan's Phase 2 parity criterion is *"SQS message
 * bodies byte-identical for the same input"*, and `JSON.stringify` is **not** byte-identical
 * to `json.dumps` in two ways that both fire on every single message this service sends:
 *
 * | | CPython `json.dumps` | `JSON.stringify` |
 * |---|---|---|
 * | separators | `', '` and `': '` — **with spaces** | `','` and `':'` |
 * | non-ASCII | `ensure_ascii=True` → `é` | emitted literally (`é`) |
 *
 * Every notification body v1 sends is Spanish and contains an accented character
 * (`"Ha sido creada una nueva solicitud de crédito"`,
 * `"Hoy está cumpliendo años …"`, `"Recuerde que la fecha límite de pago …"`), so *both*
 * differences are live on the very first message. Using `JSON.stringify` would produce a
 * message the Lambda still understands but that is not the same bytes — an unregistered
 * parity diff on the one criterion this phase is graded against.
 *
 * ## Fidelity
 *
 * Reproduces `json.dumps(obj)` with CPython 3.9 defaults:
 * `skipkeys=False, ensure_ascii=True, check_circular=True, allow_nan=True, indent=None,
 * separators=None, sort_keys=False`. Key order is the object's own insertion order, which is
 * what makes `parseHstore`'s order preservation observable (§2 of the plan: hstore key order
 * is part of the wire format).
 *
 * Every expectation in `python-json-dumps.spec.ts` was captured from `python:3.9-slim`, not
 * written from memory.
 *
 * ## Deliberate limits
 *
 * * Only the value shapes v1 can produce are supported: `string`, `number`, `bigint`
 *   (Python `int`), `boolean`, `null`, arrays and plain objects. Anything else throws, the
 *   way CPython raises `TypeError: Object of type X is not JSON serializable` — silently
 *   emitting `null` (JSON.stringify's behaviour for `undefined`) would corrupt a payload.
 * * A `Date` therefore throws too. CPython does the same; if a date ever needs to go into a
 *   message it must be formatted at the call site, where the timezone question is visible.
 */

/** The value shapes CPython's default `JSONEncoder` can serialise, as they arrive from v2. */
export type PythonJsonValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | readonly PythonJsonValue[]
  | { readonly [key: string]: PythonJsonValue };

/**
 * `json.dumps(value)` with CPython's defaults.
 *
 * @throws TypeError for a value CPython's default encoder would reject, and for a circular
 *   structure (`ValueError: Circular reference detected` — reported as a `TypeError` here
 *   because JavaScript has no distinct `ValueError`).
 */
export function pythonJsonDumps(value: PythonJsonValue): string {
  return encodeValue(value, new Set<object>());
}

function encodeValue(value: PythonJsonValue, seen: Set<object>): string {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'string':
      return encodePythonJsonString(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return encodeNumber(value);
    case 'bigint':
      // Python `int` has no width limit and `json` writes it in full. `BigInt` is how the
      // Prisma layer carries the 17 money columns, so this branch is load-bearing.
      return value.toString();
    case 'object':
      break;
    default:
      throw new TypeError(`Object of type ${typeof value} is not JSON serializable`);
  }

  const container = value as object;
  if (seen.has(container)) {
    throw new TypeError('Circular reference detected');
  }
  seen.add(container);
  try {
    if (Array.isArray(container)) {
      const items = (container as readonly PythonJsonValue[]).map((item) =>
        encodeValue(item, seen),
      );
      return `[${items.join(', ')}]`;
    }
    if (
      Object.getPrototypeOf(container) !== Object.prototype &&
      Object.getPrototypeOf(container) !== null
    ) {
      // `Date`, `Map`, class instances… CPython's default encoder rejects all of them.
      throw new TypeError(`Object of type ${container.constructor.name} is not JSON serializable`);
    }
    const entries = Object.entries(container as Record<string, PythonJsonValue>).map(
      ([key, item]) => `${encodePythonJsonString(key)}: ${encodeValue(item, seen)}`,
    );
    return `{${entries.join(', ')}}`;
  } finally {
    seen.delete(container);
  }
}

/**
 * `float.__repr__` / `int.__repr__` as the C encoder emits them.
 *
 * JavaScript has one numeric type, so an integral `number` is treated as a Python `int`
 * (no `.0` suffix) — which is what every v1 payload actually holds. `allow_nan=True` is
 * CPython's default, so `NaN` / `Infinity` are written as bare tokens rather than becoming
 * `null` the way `JSON.stringify` does.
 */
function encodeNumber(value: number): string {
  if (Number.isNaN(value)) {
    return 'NaN';
  }
  if (value === Number.POSITIVE_INFINITY) {
    return 'Infinity';
  }
  if (value === Number.NEGATIVE_INFINITY) {
    return '-Infinity';
  }
  if (Number.isInteger(value)) {
    // `-0` is `0` in Python's eyes and `String(-0)` is already "0".
    return value.toFixed(0);
  }
  // Both CPython's `repr` and JS's `Number#toString` emit the shortest round-tripping
  // decimal, so they agree on every finite double (`0.1`, `1.5`, `1e+21`, `5e-324`).
  return String(value);
}

/** `\b \t \n \f \r` — the five control characters CPython gives a short escape. */
const SHORT_ESCAPES: ReadonlyMap<number, string> = new Map([
  [0x08, '\\b'],
  [0x09, '\\t'],
  [0x0a, '\\n'],
  [0x0c, '\\f'],
  [0x0d, '\\r'],
]);

/**
 * `json.encoder.py_encode_basestring_ascii`, i.e. the `ensure_ascii=True` string encoder.
 *
 * Escapes `"` and `\`, the five short control escapes, every other code unit below `0x20`,
 * **and everything from `0x7f` up** — including DEL, which `JSON.stringify` leaves literal.
 * Astral characters come out as a `\uXXXX\uXXXX` surrogate pair because JavaScript strings
 * are already UTF-16 and CPython's encoder emits the same pair.
 */
export function encodePythonJsonString(value: string): string {
  let out = '"';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const char = value[index];
    if (char === '"') {
      out += '\\"';
      continue;
    }
    if (char === '\\') {
      out += '\\\\';
      continue;
    }
    const short = SHORT_ESCAPES.get(code);
    if (short !== undefined) {
      out += short;
      continue;
    }
    if (code < 0x20 || code >= 0x7f) {
      out += `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }
    out += char;
  }
  return `${out}"`;
}
