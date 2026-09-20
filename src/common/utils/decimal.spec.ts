import { describe, expect, it } from '@jest/globals';
import { Decimal, toDecimal } from './decimal';

/**
 * **Condition C49/n3.** The `Decimal` configuration in `decimal.ts` is pinned *behaviourally*
 * by three interest assertions in `amortization.spec.ts`, three directories away — which is
 * the stronger test and the reason no direct assertion existed. What it does not do is put the
 * **reason** where the next person changing that config will look.
 *
 * Every expected value below was read out of the pinned v1 container, not derived:
 *
 * ```
 * >>> decimal.getcontext()
 * Context(prec=28, rounding=ROUND_HALF_EVEN, Emin=-999999, Emax=999999, capitals=1, clamp=0, …)
 * >>> Decimal(1)/Decimal(7)   -> 0.1428571428571428571428571429
 * >>> Decimal(100)/Decimal(3) -> 33.33333333333333333333333333
 * ```
 *
 * That context is not a choice v2 made; it is CPython's **default**, which is what every
 * `Decimal` computation in `fondo_api/services/loan.py` runs under because v1 never installs
 * one. `decimal.js` defaults to `precision: 20`, so leaving it alone would have silently
 * disagreed with v1 on the eight digits that decide the cents in a long-running loan's
 * amortisation table.
 */
describe('Decimal — configured as CPython’s default decimal context', () => {
  it('keeps 28 significant digits, not decimal.js’s default 20', () => {
    expect(Decimal.precision).toBe(28);
    // The discriminator: at precision 20 this is `0.14285714285714285714`.
    expect(new Decimal(1).div(7).toString()).toBe('0.1428571428571428571428571429');
    expect(new Decimal(100).div(3).toString()).toBe('33.33333333333333333333333333');
  });

  it('rounds half to even, as `ROUND_HALF_EVEN` does — not half away from zero', () => {
    expect(Decimal.rounding).toBe(Decimal.ROUND_HALF_EVEN);
    expect(new Decimal('2.5').toDecimalPlaces(0).toString()).toBe('2');
    expect(new Decimal('3.5').toDecimalPlaces(0).toString()).toBe('4');
    // `Math.round` disagrees with both, which is why `rounding.util.ts` exists.
    expect(Math.round(2.5)).toBe(3);
  });

  it('never renders in exponential notation, because rendered HTML would carry it', () => {
    expect(new Decimal('1e-9').toString()).toBe('0.000000001');
    expect(new Decimal('30000000000').toString()).toBe('30000000000');
  });

  it('toDecimal never routes a bigint or a Prisma Decimal through a binary float', () => {
    // 2**53 + 1 — the smallest integer a double cannot represent.
    expect(toDecimal(9007199254740993n).toString()).toBe('9007199254740993');
    expect(toDecimal({ toString: () => '0.0225' }).toString()).toBe('0.0225');
  });
});
