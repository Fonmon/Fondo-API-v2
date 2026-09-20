import DecimalJs from 'decimal.js';

/**
 * A `decimal.js` constructor configured to behave like Python's **default decimal
 * context**, which is what every `Decimal` computation in v1 runs under:
 *
 *   Context(prec=28, rounding=ROUND_HALF_EVEN, Emin=-999999, Emax=999999)
 *
 * `precision: 28` matters: `fondo_api/services/loan.py::__generate_table` computes
 * `Decimal(loan.value) / fee`, and the number of significant digits kept in that quotient
 * decides the cents that later feed the amortisation table. decimal.js defaults to 20,
 * which would silently disagree with v1 on long-running loans.
 *
 * `toExpNeg` / `toExpPos` are pushed out so `toString()` never switches to exponential
 * notation — Python's `Decimal.__str__` only does so outside a far wider range, and any
 * difference here would leak into rendered email HTML.
 */
export const Decimal = DecimalJs.clone({
  precision: 28,
  rounding: DecimalJs.ROUND_HALF_EVEN,
  toExpNeg: -9e15,
  toExpPos: 9e15,
  minE: -999999,
  maxE: 999999,
});

export type Decimal = InstanceType<typeof Decimal>;

/** Anything that can be turned into a `Decimal` without going through a JS float. */
export type DecimalInput = Decimal | string | number | bigint | { toString(): string };

/**
 * Converts to `Decimal` without ever passing through a binary float.
 *
 * `bigint` and Prisma's own `Decimal` are stringified first: `new Decimal(1e21)` and
 * `Number(someBigInt)` both lose precision on values a money column can legitimately hold.
 */
export function toDecimal(value: DecimalInput): Decimal {
  if (value instanceof Decimal) {
    return value;
  }
  if (typeof value === 'number') {
    return new Decimal(value);
  }
  if (typeof value === 'string') {
    return new Decimal(value);
  }
  return new Decimal(value.toString());
}
