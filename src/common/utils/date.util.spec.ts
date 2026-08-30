import { days360, daysInMonth, isLastDay, toPlainDate } from './date.util';

const d = (year: number, month: number, day: number): Date =>
  new Date(Date.UTC(year, month - 1, day));

/**
 * Direct port of `fondo_api/tests/test_date_utils.py::DateUtilsTest`.
 * Every expected value is copied from v1's assertions, not recomputed.
 */
describe('days360 (port of fondo_api/services/utils/date.py)', () => {
  describe('test_case_nasd', () => {
    it.each([
      [d(2018, 3, 28), d(2019, 3, 27), 359],
      [d(2018, 2, 28), d(2018, 3, 28), 28],
      [d(2018, 4, 29), d(2018, 5, 31), 32],
      [d(2018, 4, 30), d(2018, 5, 31), 30],
      [d(2018, 2, 27), d(2018, 5, 31), 94],
      [d(2018, 2, 28), d(2018, 3, 31), 30],
      [d(2018, 3, 29), d(2018, 5, 31), 62],
      // negative range: v1 swaps the dates and still returns a positive count
      [d(2018, 5, 31), d(2018, 3, 29), 62],
      [d(2018, 3, 10), d(2018, 3, 31), 21],
      [d(2012, 2, 29), d(2013, 2, 28), 358],
      [d(2016, 1, 1), d(2016, 12, 31), 360],
      [d(2012, 2, 29), d(2016, 2, 29), 1439],
    ])('days360(%s, %s) === %i', (start, end, expected) => {
      expect(days360(start, end)).toBe(expected);
    });
  });

  describe('test_case_european', () => {
    it.each([
      [d(2018, 3, 28), d(2019, 3, 27), 359],
      [d(2018, 2, 28), d(2018, 3, 28), 30],
      [d(2018, 4, 29), d(2018, 5, 31), 31],
      [d(2018, 4, 30), d(2018, 5, 31), 30],
      [d(2018, 2, 27), d(2018, 5, 31), 93],
      [d(2018, 2, 28), d(2018, 3, 31), 32],
      [d(2018, 3, 29), d(2018, 5, 31), 61],
      [d(2018, 5, 31), d(2018, 3, 29), 61],
      [d(2018, 3, 10), d(2018, 3, 31), 20],
      [d(2012, 2, 29), d(2013, 2, 28), 359],
      [d(2016, 1, 1), d(2016, 12, 31), 359],
      [d(2012, 2, 29), d(2016, 2, 29), 1440],
    ])('days360(%s, %s, european) === %i', (start, end, expected) => {
      expect(days360(start, end, true)).toBe(expected);
    });
  });

  describe('extra edge cases the v1 suite does not cover', () => {
    it('returns 0 for identical dates (v1 short-circuits on a zero delta)', () => {
      expect(days360(d(2018, 3, 28), d(2018, 3, 28))).toBe(0);
      expect(days360(d(2018, 2, 28), d(2018, 2, 28))).toBe(0);
      expect(days360(d(2018, 3, 31), d(2018, 3, 31), true)).toBe(0);
    });

    it('is symmetric: swapping the arguments never changes the result', () => {
      const pairs: [Date, Date][] = [
        [d(2018, 1, 31), d(2018, 2, 28)],
        [d(2019, 12, 31), d(2020, 1, 1)],
        [d(2020, 2, 29), d(2020, 3, 31)],
      ];
      for (const [a, b] of pairs) {
        expect(days360(a, b)).toBe(days360(b, a));
        expect(days360(a, b, true)).toBe(days360(b, a, true));
      }
    });

    it('treats a last-day-of-month start as day 30 (US NASD only)', () => {
      // 31 Jan -> 28 Feb: start becomes 30, so 30 + (28 - 30) = 28
      expect(days360(d(2018, 1, 31), d(2018, 2, 28))).toBe(28);
      // European caps both at 30: 30 + (28 - 30) = 28 as well
      expect(days360(d(2018, 1, 31), d(2018, 2, 28), true)).toBe(28);
      // 30 Apr (last day) -> 31 May: 30/31 rule then pulls the end back to 30
      expect(days360(d(2018, 4, 30), d(2018, 5, 31))).toBe(30);
    });

    it('applies the 30/31 rule only when the start day is already 30', () => {
      // start day 31 is NOT rewritten to 30 unless it is the last day of the month,
      // which for a 31-day month it always is - so 31 Mar -> 31 May is 60.
      expect(days360(d(2018, 3, 31), d(2018, 5, 31))).toBe(60);
      // start day 29 stays 29, end day 31 stays 31
      expect(days360(d(2018, 3, 29), d(2018, 3, 31))).toBe(2);
    });

    it('accepts plain-date objects as well as Date instances', () => {
      expect(days360({ year: 2018, month: 3, day: 28 }, { year: 2019, month: 3, day: 27 })).toBe(
        359,
      );
    });
  });
});

describe('isLastDay', () => {
  it.each([
    [d(2018, 2, 28), true],
    [d(2018, 2, 27), false],
    [d(2012, 2, 29), true],
    [d(2018, 4, 30), true],
    [d(2018, 4, 29), false],
    [d(2018, 12, 31), true],
    [d(2018, 1, 1), false],
  ])('isLastDay(%s) === %s', (date, expected) => {
    expect(isLastDay(date)).toBe(expected);
  });
});

describe('daysInMonth', () => {
  it.each([
    [2018, 1, 31],
    [2018, 2, 28],
    [2012, 2, 29],
    [2000, 2, 29],
    [1900, 2, 28],
    [2018, 4, 30],
    [2018, 12, 31],
  ])('daysInMonth(%i, %i) === %i', (year, month, expected) => {
    expect(daysInMonth(year, month)).toBe(expected);
  });
});

describe('toPlainDate', () => {
  it('reads UTC parts, so a Date at UTC midnight keeps its calendar day', () => {
    expect(toPlainDate(new Date('2018-03-28T00:00:00.000Z'))).toEqual({
      year: 2018,
      month: 3,
      day: 28,
    });
  });
});
