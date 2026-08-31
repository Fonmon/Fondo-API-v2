import {
  SchedulerRepeat,
  addRelativeDelta,
  addRelativeDeltaToInstant,
  nextRepeatRunDate,
} from './relativedelta.util';
import type { PlainDate } from './date.util';

/**
 * Port of `dateutil.relativedelta` month/year arithmetic — closing review condition C3.
 *
 * **Provenance of every expected value below.** They were produced by running
 * `python-dateutil==2.7.5` (the version pinned in v1's `requirements.txt`) on CPython 3.9
 * inside a container, and copied here verbatim:
 *
 * ```
 * docker run --rm python:3.9-slim sh -c "pip install -q python-dateutil==2.7.5;
 *   python -c \"
 * import datetime
 * from dateutil.relativedelta import relativedelta
 * print(datetime.date(2018, 1, 31) + relativedelta(months=1))   # -> 2018-02-28
 * \""
 * ```
 *
 * Nothing here was computed from the implementation under test and nothing was reasoned out
 * by hand — month-end behaviour is exactly where a plausible-looking expectation is wrong.
 */

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

const iso = (date: PlainDate): string =>
  pad(date.year, 4) + '-' + pad(date.month) + '-' + pad(date.day);

const parse = (value: string): PlainDate => {
  const [year, month, day] = value.split('-').map(Number);
  return { year: year ?? 0, month: month ?? 0, day: day ?? 0 };
};

describe('addRelativeDelta — years and months clamp to the end of the target month', () => {
  it.each([
    ['2018-01-31', { months: 1 }, '2018-02-28'],
    ['2018-01-31', { months: -1 }, '2017-12-31'],
    ['2018-01-31', { years: 1 }, '2019-01-31'],
    ['2018-01-31', { years: -1 }, '2017-01-31'],
    ['2018-01-30', { months: 1 }, '2018-02-28'],
    ['2018-01-30', { months: -1 }, '2017-12-30'],
    ['2018-01-30', { years: 1 }, '2019-01-30'],
    ['2018-01-30', { years: -1 }, '2017-01-30'],
    ['2018-01-29', { months: 1 }, '2018-02-28'],
    ['2018-01-29', { months: -1 }, '2017-12-29'],
    ['2018-01-29', { years: 1 }, '2019-01-29'],
    ['2018-01-29', { years: -1 }, '2017-01-29'],
    ['2018-01-28', { months: 1 }, '2018-02-28'],
    ['2018-01-28', { months: -1 }, '2017-12-28'],
    ['2018-01-28', { years: 1 }, '2019-01-28'],
    ['2018-01-28', { years: -1 }, '2017-01-28'],
    ['2020-01-31', { months: 1 }, '2020-02-29'],
    ['2020-01-31', { months: -1 }, '2019-12-31'],
    ['2020-01-31', { years: 1 }, '2021-01-31'],
    ['2020-01-31', { years: -1 }, '2019-01-31'],
    ['2020-01-30', { months: 1 }, '2020-02-29'],
    ['2020-01-30', { months: -1 }, '2019-12-30'],
    ['2020-01-30', { years: 1 }, '2021-01-30'],
    ['2020-01-30', { years: -1 }, '2019-01-30'],
    ['2020-01-29', { months: 1 }, '2020-02-29'],
    ['2020-01-29', { months: -1 }, '2019-12-29'],
    ['2020-01-29', { years: 1 }, '2021-01-29'],
    ['2020-01-29', { years: -1 }, '2019-01-29'],
    ['2018-03-31', { months: 1 }, '2018-04-30'],
    ['2018-03-31', { months: -1 }, '2018-02-28'],
    ['2018-03-31', { years: 1 }, '2019-03-31'],
    ['2018-03-31', { years: -1 }, '2017-03-31'],
    ['2018-05-31', { months: 1 }, '2018-06-30'],
    ['2018-05-31', { months: -1 }, '2018-04-30'],
    ['2018-05-31', { years: 1 }, '2019-05-31'],
    ['2018-05-31', { years: -1 }, '2017-05-31'],
    ['2018-08-31', { months: 1 }, '2018-09-30'],
    ['2018-08-31', { months: -1 }, '2018-07-31'],
    ['2018-08-31', { years: 1 }, '2019-08-31'],
    ['2018-08-31', { years: -1 }, '2017-08-31'],
    ['2018-10-31', { months: 1 }, '2018-11-30'],
    ['2018-10-31', { months: -1 }, '2018-09-30'],
    ['2018-10-31', { years: 1 }, '2019-10-31'],
    ['2018-10-31', { years: -1 }, '2017-10-31'],
    ['2018-12-31', { months: 1 }, '2019-01-31'],
    ['2018-12-31', { months: -1 }, '2018-11-30'],
    ['2018-12-31', { years: 1 }, '2019-12-31'],
    ['2018-12-31', { years: -1 }, '2017-12-31'],
    ['2019-02-28', { months: 1 }, '2019-03-28'],
    ['2019-02-28', { months: -1 }, '2019-01-28'],
    ['2019-02-28', { years: 1 }, '2020-02-28'],
    ['2019-02-28', { years: -1 }, '2018-02-28'],
    ['2020-02-29', { months: 1 }, '2020-03-29'],
    ['2020-02-29', { months: -1 }, '2020-01-29'],
    ['2020-02-29', { years: 1 }, '2021-02-28'],
    ['2020-02-29', { years: -1 }, '2019-02-28'],
    ['2018-11-30', { months: 1 }, '2018-12-30'],
    ['2018-11-30', { months: -1 }, '2018-10-30'],
    ['2018-11-30', { years: 1 }, '2019-11-30'],
    ['2018-11-30', { years: -1 }, '2017-11-30'],
    ['2018-07-31', { months: 1 }, '2018-08-31'],
    ['2018-07-31', { months: -1 }, '2018-06-30'],
    ['2018-07-31', { years: 1 }, '2019-07-31'],
    ['2018-07-31', { years: -1 }, '2017-07-31'],
  ])('%s + %o === %s', (base, delta, expected) => {
    expect(iso(addRelativeDelta(parse(base), delta))).toBe(expected);
  });
});

describe('addRelativeDelta — days and weeks are a plain timedelta, never clamped', () => {
  it.each([
    ['2018-03-01', { days: -5 }, '2018-02-24'],
    ['2018-01-01', { days: -1 }, '2017-12-31'],
    ['2018-12-31', { days: 1 }, '2019-01-01'],
    ['2020-02-28', { days: 1 }, '2020-02-29'],
    ['2019-02-28', { days: 1 }, '2019-03-01'],
    ['2018-01-25', { weeks: 1 }, '2018-02-01'],
    ['2018-12-28', { weeks: 1 }, '2019-01-04'],
    ['2020-02-29', { days: 1 }, '2020-03-01'],
    ['2020-03-01', { days: -1 }, '2020-02-29'],
    ['2018-03-05', { days: -5 }, '2018-02-28'],
    ['2018-03-03', { days: -5 }, '2018-02-26'],
  ])('%s + %o === %s', (base, delta, expected) => {
    expect(iso(addRelativeDelta(parse(base), delta))).toBe(expected);
  });
});

describe('addRelativeDelta — |months| > 11 folds into years (dateutil _fix)', () => {
  it.each([
    ['2017-12-31', { months: 12 }, '2018-12-31'],
    ['2017-12-31', { months: 14 }, '2019-02-28'],
    ['2018-01-31', { months: 36 }, '2021-01-31'],
    ['2018-01-31', { months: -14 }, '2016-11-30'],
  ])('%s + %o === %s', (base, delta, expected) => {
    expect(iso(addRelativeDelta(parse(base), delta))).toBe(expected);
  });
});

describe('the amortisation table: initial_date + relativedelta(months=+i)', () => {
  // `services/loan.py:247`. The clamp is applied to the *original* date each time, so the
  // 31st reappears in every 31-day month instead of sticking at 28.
  const initialDate = parse('2017-12-31');

  it.each([
    [1, '2018-01-31'],
    [2, '2018-02-28'],
    [3, '2018-03-31'],
    [4, '2018-04-30'],
    [5, '2018-05-31'],
    [6, '2018-06-30'],
    [7, '2018-07-31'],
    [8, '2018-08-31'],
    [9, '2018-09-30'],
    [10, '2018-10-31'],
    [11, '2018-11-30'],
    [12, '2018-12-31'],
  ])('month +%i === %s', (offset, expected) => {
    expect(iso(addRelativeDelta(initialDate, { months: offset }))).toBe(expected);
  });
});

describe('create_repeat_instance: the clone chain drifts, because each clone re-clamps', () => {
  /**
   * `scheduler/tasks.py:30-41` reads `task.run_date` — the *previous clone* — so a MONTHLY
   * task first scheduled on the 31st is pinned to the 28th from its second run onward and
   * never returns to the 31st. v1's behaviour; reproduced, not fixed.
   */
  it('MONTHLY from 2018-01-31 collapses onto the 28th and stays there', () => {
    const expected = [
      '2018-01-31',
      '2018-02-28',
      '2018-03-28',
      '2018-04-28',
      '2018-05-28',
      '2018-06-28',
      '2018-07-28',
      '2018-08-28',
      '2018-09-28',
      '2018-10-28',
      '2018-11-28',
      '2018-12-28',
      '2019-01-28',
      '2019-02-28',
    ];

    let runDate = new Date('2018-01-31T00:00:00.000Z');
    const actual = [runDate.toISOString().slice(0, 10)];
    for (let index = 0; index < expected.length - 1; index += 1) {
      const next = nextRepeatRunDate(runDate, SchedulerRepeat.MONTHLY);
      expect(next).not.toBeNull();
      runDate = next as Date;
      actual.push(runDate.toISOString().slice(0, 10));
    }

    expect(actual).toEqual(expected);
  });

  it('YEARLY from a leap day loses the 29th permanently', () => {
    // The Phase 3 birthday task (`repeat = 4`) of a member born on 29 February.
    const expected = [
      '2020-02-29T00:00:00.000Z',
      '2021-02-28T00:00:00.000Z',
      '2022-02-28T00:00:00.000Z',
      '2023-02-28T00:00:00.000Z',
      '2024-02-28T00:00:00.000Z',
      '2025-02-28T00:00:00.000Z',
    ];

    let runDate = new Date(expected[0]);
    const actual = [runDate.toISOString()];
    for (let index = 0; index < expected.length - 1; index += 1) {
      runDate = nextRepeatRunDate(runDate, SchedulerRepeat.YEARLY) as Date;
      actual.push(runDate.toISOString());
    }

    expect(actual).toEqual(expected);
  });
});

describe('addRelativeDeltaToInstant — preserves the time of day (SchedulerTask.run_date)', () => {
  it.each([
    ['2018-01-31T10:00:00Z', { months: 1 }, '2018-02-28T10:00:00.000Z'],
    ['2020-02-29T14:30:00Z', { years: 1 }, '2021-02-28T14:30:00.000Z'],
    ['2018-01-31T00:00:00Z', { years: 1 }, '2019-01-31T00:00:00.000Z'],
    ['2019-02-28T23:59:59Z', { years: 1 }, '2020-02-28T23:59:59.000Z'],
    ['2018-08-31T05:00:00Z', { months: 1 }, '2018-09-30T05:00:00.000Z'],
  ])('%s + %o === %s', (base, delta, expected) => {
    expect(addRelativeDeltaToInstant(new Date(base), delta).toISOString()).toBe(expected);
  });

  it('keeps seconds and milliseconds untouched across the clamp', () => {
    const instant = new Date('2018-01-31T10:20:30.456Z');
    expect(addRelativeDeltaToInstant(instant, { months: 1 }).toISOString()).toBe(
      '2018-02-28T10:20:30.456Z',
    );
  });
});

describe('nextRepeatRunDate — SchedulerTask.repeat (models.py:103-109)', () => {
  const runDate = new Date('2018-01-31T14:00:00.000Z');

  it('returns null for NONE, so no clone row is written', () => {
    // `create_repeat_instance` starts with `if task.repeat != 0`.
    expect(nextRepeatRunDate(runDate, SchedulerRepeat.NONE)).toBeNull();
  });

  it.each([
    [SchedulerRepeat.DAILY, '2018-02-01T14:00:00.000Z'],
    [SchedulerRepeat.WEEKLY, '2018-02-07T14:00:00.000Z'],
    [SchedulerRepeat.MONTHLY, '2018-02-28T14:00:00.000Z'],
    [SchedulerRepeat.YEARLY, '2019-01-31T14:00:00.000Z'],
  ])('repeat %i clones to %s', (repeat, expected) => {
    expect(nextRepeatRunDate(runDate, repeat)?.toISOString()).toBe(expected);
  });
});
