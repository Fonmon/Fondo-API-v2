import { Decimal, toDecimal, type DecimalInput } from '../utils/decimal';
import { roundHalfDownDecimal } from '../utils/rounding.util';
import type { PlainDate } from '../utils/date.util';

/**
 * Byte-exact reimplementation of the Babel calls v1 uses to render Spanish dates and money.
 *
 * ## Why not `Intl`?
 *
 * v1 pins `Babel==2.9.1` and calls
 * `babel.dates.format_date(value, locale=settings.LANGUAGE_LOCALE)` (locale `es`, default
 * `medium` format) and
 * `babel.numbers.format_number(babel.numbers.format_decimal(round(v, 2), format='#'), locale='es')`.
 *
 * Node's `Intl` is backed by whatever ICU/CLDR release the runtime ships, which drifts
 * between Node versions and does **not** agree with Babel 2.9.1 — notably on the trailing
 * period in Spanish abbreviated month names (`sept.` vs `sept`). Phase 2 and Phase 4 assert
 * email HTML byte-for-byte, so the CLDR data v1 actually used is inlined below and pinned
 * by tests taken from v1's own expected strings.
 *
 * Reference strings lifted from v1:
 *   - `fondo_api/tests/test_mail_service.py`      -> `'26 sept. 2021'`
 *   - `fondo_api/tests/test_loan_views.py`        -> `'9 dic. 2017'`, `'9 nov. 2017'`,
 *     `'9 ene. 2018'` ... `'9 sept. 2018'`, and the `$200 / $180 / $24` table cells.
 */

/**
 * CLDR `es` abbreviated month names as shipped in Babel 2.9.1 — including the trailing
 * period, and including the four-letter `sept.`.
 */
export const SPANISH_ABBREVIATED_MONTHS: readonly string[] = [
  'ene.',
  'feb.',
  'mar.',
  'abr.',
  'may.',
  'jun.',
  'jul.',
  'ago.',
  'sept.',
  'oct.',
  'nov.',
  'dic.',
];

/** CLDR `es` grouping separator for the standard decimal pattern `#,##0.###`. */
const GROUP_SEPARATOR = '.';
/** CLDR `es` decimal separator. */
const DECIMAL_SEPARATOR = ',';
/** `#,##0.###` — at most three fraction digits, at least one integer digit. */
const MAX_FRACTION_DIGITS = 3;

/**
 * `babel.dates.format_date(value, locale='es')`.
 *
 * The `es` `medium` skeleton is `d MMM y`: day without a leading zero, abbreviated month,
 * full year.
 *
 * ## Only takes a {@link PlainDate} — deliberately (reviewer S1, plan rule 5c)
 *
 * v1 does **not** format dates uniformly, and the difference is a calendar day:
 *
 * ```python
 * # serializers.py:88-90 — LoanSerializer.get_created_at   (timestamptz)
 * created_at = timezone.localtime(obj.created_at)          # -> America/Bogota first
 * return format_date(created_at, locale=settings.LANGUAGE_LOCALE)
 *
 * # serializers.py:29-30 — UserFinanceSerializer.get_last_modified   (DateField)
 * return format_date(obj.last_modified, ...)               # no conversion at all
 * ```
 *
 * Accepting a `Date` here would let a caller format a `timestamptz` as its **UTC** calendar
 * date, which is the next day for every instant between 19:00 and 23:59 Bogota (~21% of the
 * day) — green in CI, wrong in production, and asserted byte-for-byte in Phase 2/4 email HTML.
 * So the conversion is forced to the call site, where the column's type is known:
 *
 *  * `@db.Date` column  → `formatDateEs(fromDateColumn(row.last_modified))`
 *  * `timestamptz`      → `formatDateEs(toBogotaDate(row.created_at))`
 *
 * @example formatDateEs({ year: 2021, month: 9, day: 26 }) // '26 sept. 2021'
 */
export function formatDateEs(value: PlainDate): string {
  if (value instanceof Date) {
    // Unreachable from TypeScript; guards JS callers and `as` casts, because the failure
    // mode of the wrong conversion is a silently shifted date rather than an error.
    throw new TypeError(
      'formatDateEs expects a PlainDate, not a Date. Convert first: fromDateColumn(value) ' +
        'for an @db.Date column, toBogotaDate(value) for a timestamptz.',
    );
  }
  const { year, month, day } = value;
  const monthName = SPANISH_ABBREVIATED_MONTHS[month - 1];
  if (monthName === undefined) {
    throw new RangeError(`formatDateEs received an out-of-range month: ${month}`);
  }
  return `${day} ${monthName} ${year}`;
}

/** Inserts `.` every three digits, right to left. Babel 2.9.1 groups from 1.000 upward. */
function groupIntegerDigits(digits: string): string {
  let out = '';
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) {
      out += GROUP_SEPARATOR;
    }
    out += digits[i];
  }
  return out;
}

/**
 * `babel.numbers.format_decimal(value, locale='es')` with the locale's standard pattern
 * `#,##0.###`: group with `.`, decimal comma, at most three fraction digits, trailing
 * zeros dropped.
 *
 * Note that Babel 2.9.1 does **not** implement CLDR's `minimumGroupingDigits`, so
 * four-digit values *are* grouped: `1000` renders as `1.000`, verified against Babel 2.9.1.
 */
export function formatDecimalEs(value: DecimalInput): string {
  const decimal = toDecimal(value);
  const isNegative = decimal.isNegative();
  // Babel takes abs() before formatting and re-attaches the sign, which is how a value that
  // rounds to zero from below still renders as '-0'.
  const rounded = decimal.abs().toDecimalPlaces(MAX_FRACTION_DIGITS, Decimal.ROUND_HALF_EVEN);
  const [intPart, fracPart = ''] = rounded.toFixed().split('.');

  let out = groupIntegerDigits(intPart ?? '0');
  const trimmedFraction = fracPart.replace(/0+$/, '');
  if (trimmedFraction.length > 0) {
    out += DECIMAL_SEPARATOR + trimmedFraction;
  }
  return isNegative ? `-${out}` : out;
}

/**
 * The composite money expression from `fondo_api/services/loan.py::__generate_table`,
 * evaluated inside `decimal.localcontext(Context(rounding=ROUND_HALF_DOWN))`:
 *
 * ```python
 * format_number(format_decimal(round(value, 2), format='#'), locale='es')
 * ```
 *
 * That is **two** successive half-down roundings, not one:
 *   1. `round(value, 2)`               -> half-down to two decimals
 *   2. `format_decimal(..., format='#')` -> half-down to zero decimals (Babel quantises
 *      under the ambient decimal context, which is why v1 wraps the whole block)
 *   3. `format_number(...)`            -> re-parses the digits and applies the `es`
 *      grouping pattern
 *
 * The double rounding is observable: `20.5001` renders as `20`, not `21`, because step 1
 * pulls it down to `20.50` and step 2 then rounds that tie toward zero. Verified against
 * Babel 2.9.1. Do not "simplify" it into a single rounding.
 *
 * The caller prefixes `$`; this function returns the digits only.
 */
export function formatMoneyEs(value: DecimalInput): string {
  const twoPlaces = roundHalfDownDecimal(value, 2);
  const whole = roundHalfDownDecimal(twoPlaces, 0);
  return formatDecimalEs(whole);
}
