import { daysInMonth, type PlainDate } from './date.util';

/**
 * The CPython behaviours v1's services rely on when they read a parsed request body,
 * reproduced so that a malformed body fails in v2 exactly where and how it fails in v1.
 *
 * ⚠️ **Shared, not users-only** (review C36). It lived in `src/users/` through Phase 3;
 * `LoanView`, `ActivityView` and `FileView` subscript `request.data` the same unguarded way,
 * and a second copy of these coercions is a second, silently diverging error contract. Import
 * from here — never re-implement, and never import a Python-semantics helper out of a feature
 * module.
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
 * Django's `DateField.get_prep_value` → `to_python(value)` → `django.utils.dateparse.parse_date`.
 *
 * ```python
 * date_re = re.compile(r'(?P<year>\d{4})-(?P<month>\d{1,2})-(?P<day>\d{1,2})$')
 *
 * def to_python(self, value):
 *     ...
 *     try:
 *         parsed = parse_date(value)
 *         if parsed is not None:
 *             return parsed
 *     except ValueError:
 *         raise ValidationError(self.error_messages['invalid_date'], ...)
 *     raise ValidationError(self.error_messages['invalid'], ...)
 * ```
 *
 * ⚠️ **The month and day are `\d{1,2}`, not `\d{2}`.** v1's own loan fixtures post
 * `'2017-12-9'` and `'2018-1-1'` (`tests/test_loan_views.py:64,110`), so a `YYYY-MM-DD`-only
 * regex refuses bodies v1 accepts and writes. It is a `re.match`, so the pattern is anchored
 * at the start but **not** at the end beyond Python's `$`, which also matches before a single
 * trailing newline — `'2018-01-01\n'` parses in v1 and therefore here.
 *
 * ⚠️ An out-of-range date (`'2018-13-01'`) matches the regex and then raises `ValueError`
 * inside `datetime.date(...)`, which `to_python` converts to a `ValidationError`. A
 * **non-string** raises `TypeError` from `re.match` instead, which `to_python` does *not*
 * catch. Both are uncaught 500s at every v1 call site in Phases 3-8, so both throw here.
 *
 * Returns a {@link PlainDate}, never a `Date`: plan rule 5c makes the `@db.Date` /
 * `timestamptz` choice explicit at the call site (`plainDateToUtcDate` on the way to Prisma).
 */
export function toDjangoDate(value: unknown, field: string): PlainDate {
  if (typeof value !== 'string') {
    throw new PythonTypeError(
      `TypeError: expected string or bytes-like object (${field}), got '${describeType(value)}'`,
    );
  }
  // `re.match` + Python's `$`, which also matches immediately before one trailing '\n'.
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})\n?$/.exec(value);
  if (match === null) {
    throw new PythonTypeError(
      `ValidationError: '${value}' value has an invalid date format. It must be in YYYY-MM-DD format (${field})`,
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    // `datetime.date(...)` raises ValueError -> ValidationError('invalid_date').
    throw new PythonTypeError(
      `ValidationError: '${value}' value has the correct format (YYYY-MM-DD) but it is an invalid date (${field})`,
    );
  }
  return { year, month, day };
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

/**
 * CPython's `>` between a value straight off a JSON body and a stored integer column.
 *
 * The one call site is `create_loan`'s quota gate — the **only** raw ordering comparison in
 * v1's entire service layer:
 *
 * ```python
 * if obj['value'] > user_finance.available_quota and not refinance:   # services/loan.py:27
 * ```
 *
 * ⚠️ **This helper exists to carry a *sequencing* rule, not an arithmetic one.** Phase 3
 * established "compare the **raw** body value, coerce only on the write"
 * (`user.service.ts::updateUserFinance`, via {@link pythonNotEqual}); `createLoan` was the one
 * place in v2 that coerced first, and coercing first is observably different because
 * {@link toDjangoInt} **truncates**: with a quota of `Q`, a submitted `Q + 0.5` compares as
 * *greater* raw (v1's 406) and as *equal* coerced (a 201 storing `Q` — a different number from
 * the one the member submitted). The divergent window is exactly `Q < value < Q + 1`. Register
 * row **D29**; the boundary is pinned in both suites.
 *
 * Python semantics reproduced:
 *
 * | submitted | CPython | here |
 * |---|---|---|
 * | `int` / `float` | numeric, and **exact** — CPython never rounds an int to a float to compare | exact, via `BigInt` (see below) |
 * | `bool` | `bool` is an `int` subclass: `True > 0` is `True` | `1` / `0` |
 * | `nan` | every comparison is `False` | `false` |
 * | `str`, `None`, `list`, `dict` | `TypeError` → an uncaught **500** in v1 | {@link PythonTypeError} |
 *
 * ⚠️ The `str` row is where **D29** takes its deviation, and it is taken at the **call site**,
 * not here: `createLoan` coerces a string *before* calling this, because v1's `TypeError` on
 * `'1000' > 1000` is a crash and not a rule. Keep the deviation visible there; this helper
 * stays faithful.
 *
 * Exactness: JavaScript cannot apply `>` to a `number` and a `bigint` at the type level, so an
 * integral `number` converts exactly, and a fractional one uses `ceil` — for a non-integral
 * `s` and an integral `stored`, `s > stored` iff `ceil(s) > stored`. No double ever has to
 * represent `stored`, which is what keeps a 19-digit quota from being compared through a
 * 53-bit mantissa.
 */
export function pythonGreaterThan(submitted: unknown, stored: bigint): boolean {
  if (typeof submitted === 'bigint') {
    return submitted > stored;
  }
  if (typeof submitted === 'boolean') {
    return (submitted ? 1n : 0n) > stored;
  }
  if (typeof submitted === 'number') {
    if (Number.isNaN(submitted)) {
      return false;
    }
    if (!Number.isFinite(submitted)) {
      return submitted > 0;
    }
    return BigInt(Number.isInteger(submitted) ? submitted : Math.ceil(submitted)) > stored;
  }
  throw new PythonTypeError(
    `TypeError: '>' not supported between instances of '${pythonTypeName(submitted)}' and 'int'`,
  );
}

/** CPython's `type(x).__name__` for the shapes a JSON body can carry. */
function pythonTypeName(value: unknown): string {
  if (value === null || value === undefined) {
    return 'NoneType';
  }
  if (Array.isArray(value)) {
    return 'list';
  }
  if (typeof value === 'object') {
    return 'dict';
  }
  if (typeof value === 'string') {
    return 'str';
  }
  if (typeof value === 'boolean') {
    return 'bool';
  }
  return 'float';
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

/**
 * CPython's `int(str)`: leading/trailing whitespace is allowed, an optional sign is allowed,
 * everything else raises `ValueError`.
 *
 * v1's callers do **not** catch it, so it is a 500 rather than a 400. Call sites:
 *
 * | v1 | shape |
 * |---|---|
 * | `UserView.get` (`views/user.py:27-28`) | guarded by `if …get('page') is not None`, so it runs only when the key is **present** |
 * | `LoanView.get` (`views/loan.py:24-25`, Phase 4) | `get('state', 4)` / `get('page', '1')` — **no guard**, so it runs on every request |
 * | `LoanDetailView.patch` (`views/loan.py:63`, Phase 4) | `int(request.data['state'])`, on the body |
 *
 * ⚠️ `?page=` (empty) and `?page=abc` are therefore 500s, not 400s, on both views.
 *
 * Deliberately a plain `Error`, not a {@link PythonTypeError}: both render as a bare 500 and
 * the message is the one CPython prints.
 */
export function pythonInt(raw: string): number {
  const trimmed = raw.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) {
    throw new Error(`ValueError: invalid literal for int() with base 10: '${raw}'`);
  }
  return Number(trimmed);
}
