import { Decimal, toDecimal, type DecimalInput } from './decimal';

/**
 * Rounding helpers that reproduce v1's Python semantics exactly.
 *
 * ## Why this file exists
 *
 * Every money value in the system is a whole-unit integer produced by `int(round(x, 0))`.
 * Python's `round()` is **banker's rounding** (round-half-to-even); JavaScript's
 * `Math.round()` rounds half **up** and, worse, rounds `-0.5` to `-0` while Python rounds
 * it to `0`. They disagree on *every* exact `.5`, and the loan amortisation table compounds
 * that disagreement over up to 36 rows. Never call `Math.round` on a money path.
 *
 * v1 has two distinct rounding sites:
 *
 * | v1 code | Python semantics | helper |
 * |---|---|---|
 * | `int(round(float(data[n]), 0))` — TSV bulk upload (`loan.py`, `user.py`) | float, half-even | {@link roundHalfEven} |
 * | `int(round(decimal_value, 0))` — amortisation table (`loan.py`) | Decimal, default context, half-even | {@link roundHalfEvenDecimal} |
 * | `round(decimal_value, 2)` inside `localcontext(rounding=ROUND_HALF_DOWN)` — money rendered into the email table | Decimal, half-down | {@link roundHalfDownDecimal} |
 */

const MAX_EXACT_INTEGER = Number.MAX_SAFE_INTEGER;

/**
 * Python `int(round(value, 0))` for a **float** input.
 *
 * Round-half-to-even: ties go to the nearest even integer.
 * `0.5 -> 0`, `1.5 -> 2`, `2.5 -> 2`, `3.5 -> 4`, `-0.5 -> 0`, `-1.5 -> -2`, `-2.5 -> -2`.
 *
 * Use this wherever v1 wrote `int(round(float(x), 0))`, i.e. the TSV bulk-upload parsers,
 * where the value genuinely passes through a binary float in v1 too and reproducing the
 * float is part of parity.
 */
export function roundHalfEven(value: number): number {
  if (!Number.isFinite(value)) {
    throw new TypeError(`roundHalfEven expects a finite number, received ${String(value)}`);
  }
  // Beyond 2^53 a double has no fractional part left to round.
  if (Math.abs(value) > MAX_EXACT_INTEGER) {
    return value;
  }

  const floor = Math.floor(value);
  const fraction = value - floor;

  if (fraction > 0.5) {
    return floor + 1;
  }
  if (fraction < 0.5) {
    // `+ 0` normalises -0 to 0, matching Python's `int(-0.0) == 0`.
    return floor + 0;
  }
  // Exactly halfway: pick the even neighbour.
  return floor % 2 === 0 ? floor + 0 : floor + 1;
}

/**
 * Python `int(round(value, 0))` for a **Decimal** input, under Python's default context.
 *
 * Same half-even rule as {@link roundHalfEven}, but exact: no binary-float intermediate.
 * This is the helper for the amortisation table (`__generate_table`), where `payment_value`,
 * `interests` and `total_payment` are all `Decimal`.
 */
export function roundHalfEvenDecimal(value: DecimalInput): number {
  // `+ 0` normalises Decimal's signed zero: Python's `int(Decimal('-0'))` is `0`.
  return roundHalfEvenToDecimal(value).toNumber() + 0;
}

/** As {@link roundHalfEvenDecimal}, but keeps the result as a `Decimal`. */
export function roundHalfEvenToDecimal(value: DecimalInput): Decimal {
  return toDecimal(value).toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN);
}

/** As {@link roundHalfEvenDecimal}, but returns a `bigint` for BigInt money columns. */
export function roundHalfEvenToBigInt(value: DecimalInput): bigint {
  return BigInt(roundHalfEvenToDecimal(value).toFixed(0));
}

/**
 * Python `round(value, decimalPlaces)` under
 * `decimal.localcontext(decimal.Context(rounding=decimal.ROUND_HALF_DOWN))`.
 *
 * Round-half-down means ties go **toward zero**:
 * `0.5 -> 0`, `1.5 -> 1`, `2.5 -> 2`, `-1.5 -> -1`, `-2.5 -> -2`.
 *
 * v1 enters that context around the whole amortisation-table row block, so it governs both
 * the explicit `round(x, 2)` calls and Babel's own internal quantisation to zero decimals.
 */
export function roundHalfDownDecimal(value: DecimalInput, decimalPlaces = 0): Decimal {
  return toDecimal(value).toDecimalPlaces(decimalPlaces, Decimal.ROUND_HALF_DOWN);
}
