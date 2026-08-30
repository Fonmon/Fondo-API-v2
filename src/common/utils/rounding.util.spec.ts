import { Decimal, toDecimal } from './decimal';
import {
  roundHalfDownDecimal,
  roundHalfEven,
  roundHalfEvenDecimal,
  roundHalfEvenToBigInt,
} from './rounding.util';

/**
 * Expected values were produced by running the equivalent expression under CPython with
 * `Babel==2.9.1` (v1's pinned version), not by reasoning about the JS implementation.
 *
 *   int(round(float(x), 0))      -> roundHalfEven
 *   int(round(Decimal(x), 0))    -> roundHalfEvenDecimal
 *   round(Decimal(x), n) under ROUND_HALF_DOWN -> roundHalfDownDecimal
 */
describe('roundHalfEven (Python int(round(float(x), 0)))', () => {
  it.each([
    [0.5, 0],
    [1.5, 2],
    [2.5, 2],
    [3.5, 4],
    [4.5, 4],
    [-0.5, 0],
    [-1.5, -2],
    [-2.5, -2],
    [-3.5, -4],
    [0.4, 0],
    [0.6, 1],
    [-0.4, 0],
    [-0.6, -1],
    [2.675, 3],
    [0.49999999999999994, 0],
    [0, 0],
    [7, 7],
    [-7, -7],
    [1e16, 1e16],
  ])('roundHalfEven(%p) === %p', (input, expected) => {
    expect(roundHalfEven(input)).toBe(expected);
  });

  it('differs from Math.round on every exact .5 tie', () => {
    // The whole reason this helper exists. Math.round rounds half *up*.
    expect(Math.round(2.5)).toBe(3);
    expect(roundHalfEven(2.5)).toBe(2);
    expect(Math.round(0.5)).toBe(1);
    expect(roundHalfEven(0.5)).toBe(0);
    expect(Math.round(-1.5)).toBe(-1);
    expect(roundHalfEven(-1.5)).toBe(-2);
    expect(Math.round(-2.5)).toBe(-2);
    expect(roundHalfEven(-2.5)).toBe(-2);
  });

  it('never returns negative zero (Python int(-0.0) is 0)', () => {
    expect(Object.is(roundHalfEven(-0.5), 0)).toBe(true);
    expect(Object.is(roundHalfEven(-0.4), 0)).toBe(true);
  });

  it('rejects non-finite input rather than silently producing NaN', () => {
    expect(() => roundHalfEven(Number.NaN)).toThrow(TypeError);
    expect(() => roundHalfEven(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });

  it('matches the values v1 would derive from a TSV bulk-upload line', () => {
    // `int(round(float(data[n]), 0))` in loan.py / user.py
    const line = '12\t1500.5\t250.5\t9/12/2017\t20.5\t1480.5\t9/11/2017';
    const cols = line.split('\t');
    expect(roundHalfEven(Number(cols[1]))).toBe(1500);
    expect(roundHalfEven(Number(cols[2]))).toBe(250);
    expect(roundHalfEven(Number(cols[4]))).toBe(20);
    expect(roundHalfEven(Number(cols[5]))).toBe(1480);
  });
});

describe('roundHalfEvenDecimal (Python int(round(Decimal(x), 0)))', () => {
  it.each([
    ['0.5', 0],
    ['1.5', 2],
    ['2.5', 2],
    ['3.5', 4],
    ['-0.5', 0],
    ['-1.5', -2],
    ['20.5', 20],
    ['21.5', 22],
    ['20.4999', 20],
    ['20.5001', 21],
  ])('roundHalfEvenDecimal(%p) === %p', (input, expected) => {
    expect(roundHalfEvenDecimal(input)).toBe(expected);
  });

  it('does not go through a binary float', () => {
    // 1.005 is not exactly representable as a double; the Decimal path sees the true value.
    expect(roundHalfEvenDecimal('1.005')).toBe(1);
    expect(roundHalfEvenDecimal(toDecimal('2.675'))).toBe(3);
  });

  it('supports bigint money columns without precision loss', () => {
    expect(roundHalfEvenToBigInt('9007199254740993.4')).toBe(9007199254740993n);
    expect(roundHalfEvenToBigInt(toDecimal(12345678901234567890n))).toBe(12345678901234567890n);
  });
});

describe('roundHalfDownDecimal (Python ROUND_HALF_DOWN context)', () => {
  it.each([
    ['0.5', 0, '0'],
    ['1.5', 0, '1'],
    ['2.5', 0, '2'],
    ['3.5', 0, '3'],
    ['-1.5', 0, '-1'],
    ['-2.5', 0, '-2'],
    ['0.6', 0, '1'],
    ['0.4', 0, '0'],
    ['20.995', 2, '20.99'],
    ['20.994', 2, '20.99'],
    ['20.5001', 2, '20.5'],
    ['1.005', 2, '1'],
  ])('roundHalfDownDecimal(%p, %i) === %p', (input, places, expected) => {
    expect(roundHalfDownDecimal(input, places).toString()).toBe(expected);
  });

  it('ties go toward zero, unlike half-even', () => {
    expect(roundHalfDownDecimal('2.5').toString()).toBe('2');
    expect(roundHalfEvenDecimal('2.5')).toBe(2);
    expect(roundHalfDownDecimal('1.5').toString()).toBe('1');
    expect(roundHalfEvenDecimal('1.5')).toBe(2);
  });
});

describe('Decimal configured like Python default context', () => {
  it('keeps 28 significant digits on division, as Python does', () => {
    // Python: Decimal(1) / Decimal(3)
    //  -> Decimal('0.3333333333333333333333333333')  (28 significant digits)
    expect(new Decimal(1).div(3).toString()).toBe('0.3333333333333333333333333333');
  });

  it('never switches to exponential notation for money-sized values', () => {
    expect(new Decimal('1000').toString()).toBe('1000');
    expect(new Decimal('1000000000000').toString()).toBe('1000000000000');
    expect(new Decimal('0.001').toString()).toBe('0.001');
  });

  it('divides a loan value by its term exactly like v1', () => {
    // Decimal(loan.value) / fee in __generate_table
    expect(new Decimal(200).div(10).toString()).toBe('20');
    expect(new Decimal(100).div(3).toString()).toBe('33.33333333333333333333333333');
  });
});
