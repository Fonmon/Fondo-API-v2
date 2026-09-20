import { PythonTypeError } from '../utils/python-obj';
import { roundHalfEvenToBigInt } from '../utils/rounding.util';

/**
 * The three primitives v1's **bulk-upload** views use to turn an uploaded file into rows:
 * iterate it as lines, index a tab-separated column, and read a money column.
 *
 * ## Why this is a shared module and not four lines in a service (review C36)
 *
 * Two views parse an identically shaped, tab-separated, treasurer-produced file:
 *
 * | v1 | phase | columns |
 * |---|---|---|
 * | `UserView.patch` → `user_service.bulk_update_users` (`services/user.py:207-224`) | 3 | `identification, balance_contributions, total_quota, contributions, utilized_quota` |
 * | `LoanView.patch` → `loan_service.bulk_update_loans` (`services/loan.py`) | 4 | the fund-wide loan file |
 *
 * They are the same pipeline over different column maps. A second copy of
 * `int(round(float(x), 0))` is how the two silently diverge on a rounding edge — and the
 * divergence is money, in a 200 response with an empty body, in a file nobody re-reads.
 * Import these; do not re-implement them next to the second caller.
 *
 * ⚠️ Not a *parser* of the whole file: v1 has no CSV/TSV library in the path. It does
 * `line.trim().split('\t')` inline in the service, because the column count and the column
 * *order* are the caller's business (the user file's `contributions` is the **fourth**
 * column, not the second). Only the shared semantics live here.
 */

/**
 * `django.core.files.base.File.__iter__` — iterating an uploaded file yields **lines**.
 *
 * For `bytes`, CPython's `splitlines` breaks on `\n`, `\r` and `\r\n` only (the extra Unicode
 * line breaks are a `str` feature). A terminator at the end of the file does **not** produce a
 * trailing empty line.
 *
 * ⚠️ A genuinely blank line in the middle of the file yields `['']`, and `int('')` raises
 * `ValueError` → 500 → the whole upload rolls back. v1's behaviour, kept: a monthly file with
 * a stray blank line is rejected in full rather than applied in part.
 */
export function djangoFileLines(contents: Buffer): string[] {
  const text = contents.toString('utf8');
  if (text === '') {
    return [];
  }
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

/**
 * `data[i]` on a Python `list` — a short row raises `IndexError`, it does not yield `None`.
 *
 * Uncaught in v1 and inside `@transaction.atomic`, so a truncated line is a 500 that discards
 * the whole upload.
 */
export function requireColumn(data: readonly string[], index: number): string {
  const value = data[index];
  if (value === undefined) {
    throw new PythonTypeError(`IndexError: list index out of range (column ${index})`);
  }
  return value;
}

/**
 * `int(round(float(data[i]), 0))` — CPython's half-even `round`, **not** `Math.round`.
 *
 * `round(0.5)` is `0` and `round(2.5)` is `2` in CPython 3; `Math.round` answers 1 and 3. On a
 * monthly file of whole-peso figures the two agree, and on the one line that ends in `.5` they
 * differ by a peso — in a 200 with an empty body.
 *
 * ⚠️ **Known, deliberately unpinned divergence** (`docs/review-phase-3.md`, minor findings):
 * `Number(raw)` is not CPython's `float(str)` on two inputs — `'0x10'` is `16` here and a
 * `ValueError` there, and `'1_000'` is `NaN` here (→ our `ValueError`) and `1000.0` there.
 * Both are 500-vs-write divergences on a treasurer TSV nobody produces. Left as-is by C36,
 * which is a **pure move**; if it is ever pinned, it must be pinned **here**, once.
 */
export function parseMoneyColumn(data: readonly string[], index: number): bigint {
  const raw = requireColumn(data, index).trim();
  const asFloat = Number(raw);
  if (raw === '' || !Number.isFinite(asFloat)) {
    throw new PythonTypeError(`ValueError: could not convert string to float: '${raw}'`);
  }
  return roundHalfEvenToBigInt(asFloat);
}
