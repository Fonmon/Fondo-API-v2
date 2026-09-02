/**
 * The half-dozen CPython behaviours `fondo_api/services/user.py` relies on when it reads a
 * parsed request body, reproduced so that a malformed body fails in v2 exactly where and how
 * it fails in v1.
 *
 * v1 subscripts `request.data` directly — `obj['type']`, `obj['personal']`,
 * `obj['first_name']` — with no validation layer anywhere. Which exception that raises, and
 * *which* `try` block happens to be around it, is the whole of the error contract:
 *
 * | site | missing key raises | caught by | result |
 * |---|---|---|---|
 * | `update_user`'s `obj['type']` / `obj['preferences']` | `KeyError` | nothing | **500** |
 * | `__update_user_personal`'s `obj['first_name']` … | `KeyError` | `except DoesNotExist` / `except IntegrityError` — neither matches | **500** (rolled back) |
 * | `__update_user_preferences`'s `obj['notifications']` … | `KeyError` | a **bare** `except` | **404** |
 * | `__update_user_finance`'s `obj['contributions']` … | `KeyError` | `except UserFinance.DoesNotExist` | **500** |
 * | `activate_user`'s `obj['identification']` | `KeyError` | a **bare** `except` | **404** |
 * | `activate_user`'s `obj['password']` | `KeyError` | nothing (outside the `try`) | **500** |
 *
 * Three of those six are 500s, and reproducing them is not pedantry: a client that stops
 * sending a field must break the same way in both systems, or a parity round reads a v2 404
 * as "handled" when v1 was returning a 500 the operator would have noticed.
 */

/** `dict.__getitem__` failing. Rendered by the global filter as a bare 500. */
export class PythonKeyError extends Error {
  constructor(readonly key: string) {
    super(`KeyError: '${key}'`);
    this.name = 'PythonKeyError';
  }
}

/** `TypeError: string indices must be integers` — subscripting a non-mapping with a string. */
export class PythonTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PythonTypeError';
  }
}

/**
 * Narrows a parsed body to a mapping. A JSON array or scalar reaches v1 as a `list`/`int`
 * and `obj['type']` then raises `TypeError`, not `KeyError`.
 */
export function asPythonDict(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PythonTypeError(
      `string indices must be integers: request body is ${describeType(value)}`,
    );
  }
  return value as Record<string, unknown>;
}

/** `obj[key]` — raises {@link PythonKeyError} when the key is absent. */
export function pyGet(obj: Record<string, unknown>, key: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) {
    throw new PythonKeyError(key);
  }
  return obj[key];
}

/** `key in obj`. */
export function pyHas(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** `obj[key]` where `obj[key]` must itself be a mapping (`obj['personal']`, …). */
export function pyGetDict(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  return asPythonDict(pyGet(obj, key));
}

/**
 * Django's `BigIntegerField.get_prep_value` → `int(value)`.
 *
 * Accepts what CPython's `int()` accepts from a JSON body: an integral number, a bigint, or a
 * decimal string. A float with a fractional part is **truncated** by `int()`, and anything
 * else raises `ValueError` / `TypeError`, which is a 500 in v1's write paths.
 */
export function toDjangoInt(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new PythonTypeError(`ValueError: cannot convert ${String(value)} to integer`);
    }
    return BigInt(Math.trunc(value));
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^[+-]?\d+$/.test(trimmed)) {
      return BigInt(trimmed);
    }
    throw new PythonTypeError(
      `ValueError: invalid literal for int() with base 10: '${value}' (${field})`,
    );
  }
  if (typeof value === 'boolean') {
    // Python's `int(True)` is 1. Reachable from a JSON body; reproduced rather than refused.
    return value ? 1n : 0n;
  }
  throw new PythonTypeError(
    `TypeError: int() argument must be a string or a number, not '${describeType(value)}' (${field})`,
  );
}

/** {@link toDjangoInt} narrowed to a JavaScript `number`, for the small integer columns. */
export function toDjangoSmallInt(value: unknown, field: string): number {
  return Number(toDjangoInt(value, field));
}

/**
 * Django's `BooleanField.to_python`, which is what `get_prep_value` calls on save.
 *
 * ```python
 * if value in (True, False):      return bool(value)
 * if value in ('t', 'True', '1'): return True
 * if value in ('f', 'False', '0'):return False
 * raise ValidationError(...)
 * ```
 */
export function toDjangoBool(value: unknown, field: string): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === 1 || value === 't' || value === 'True' || value === '1') {
    return true;
  }
  if (value === 0 || value === 'f' || value === 'False' || value === '0') {
    return false;
  }
  throw new PythonTypeError(
    `ValidationError: '${String(value)}' value must be either True or False (${field})`,
  );
}

/**
 * Django's `CharField.get_prep_value` → `str(value)`. A JSON `null` becomes the four
 * characters `None`, which is what v1 would store in a `varchar` column.
 */
export function toDjangoText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null || value === undefined) {
    return 'None';
  }
  if (typeof value === 'boolean') {
    return value ? 'True' : 'False';
  }
  return describeValue(value);
}

/**
 * CPython's `!=` between a stored scalar and a value straight off a JSON body.
 *
 * ⚠️ Deliberately **not** the type-normalising comparison `changedFields` uses. They answer
 * different questions and v1 answers them differently too:
 *
 *  * `changedFields` (`auth/policies`) decides *authorisation* — "did the caller try to
 *    change a privileged field" — and must not fire on `"3"` vs `3`, or every stale client
 *    gets a phantom 403 (§7 "C8 resolved", rule 3).
 *  * This one decides *whether v1 would have written the row*, and Python says `2000 != '2000'`
 *    is **True**: a finance section submitting stringified numbers writes and bumps
 *    `last_modified` in v1, so it must here too.
 */
export function pythonNotEqual(stored: bigint | boolean | number, submitted: unknown): boolean {
  if (typeof stored === 'boolean') {
    return typeof submitted !== 'boolean' || submitted !== stored;
  }
  if (typeof submitted === 'bigint') {
    return BigInt(stored) !== submitted;
  }
  if (typeof submitted === 'number') {
    return !Number.isInteger(submitted) || BigInt(submitted) !== BigInt(stored);
  }
  // A string, null, object … never equals a Python int.
  return true;
}

/** A safe `str()`-ish rendering for an error message; never `[object Object]`. */
function describeValue(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    return describeType(value);
  }
  return String(value);
}

function describeType(value: unknown): string {
  if (value === null) {
    return 'NoneType';
  }
  if (Array.isArray(value)) {
    return 'list';
  }
  return typeof value;
}
