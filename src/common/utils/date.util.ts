/**
 * Port of `fondo_api/services/utils/date.py`.
 *
 * Day-count conventions used to price loan interest:
 *   interest = ((balance * rate) / 30) * days360(from, to)
 *
 * Behaviour is reproduced literally, including the quirk that a **negative** range is not
 * negative: v1 swaps the two dates and returns a positive count.
 */

/** A calendar date with no time and no timezone — the JS analogue of Python's `date`. */
export interface PlainDate {
  /** Full year, e.g. 2018. */
  year: number;
  /** 1-12. Note: **not** zero-based, unlike `Date.getMonth()`. */
  month: number;
  /** 1-31. */
  day: number;
}

export type DateLike = PlainDate | Date;

function isPlainDate(value: DateLike): value is PlainDate {
  return !(value instanceof Date);
}

/**
 * Reads the calendar parts of a `Date` in **UTC**.
 *
 * Prisma returns `@db.Date` columns as a `Date` pinned to UTC midnight, so UTC parts are
 * the stored calendar date. Using local getters here would shift the date by a day for any
 * process running west of Greenwich — including `America/Bogota`.
 */
export function toPlainDate(value: DateLike): PlainDate {
  if (isPlainDate(value)) {
    return { year: value.year, month: value.month, day: value.day };
  }
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
  };
}

/** Number of days in the given month. `month` is 1-12. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Port of `isLastDay(date)`. */
export function isLastDay(value: DateLike): boolean {
  const date = toPlainDate(value);
  return daysInMonth(date.year, date.month) === date.day;
}

/** Negative when `a` is before `b`, zero when equal, positive when after. */
function compare(a: PlainDate, b: PlainDate): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

/**
 * 30/360 day count.
 *
 * @param startDate first date
 * @param endDate   second date
 * @param europeanMethod `false` (default) = US NASD, `true` = European 30E/360
 *
 * v1 semantics kept verbatim:
 *  - identical dates return `0`;
 *  - if `endDate` precedes `startDate` the pair is **swapped**, so the result is always
 *    non-negative;
 *  - US NASD: if the start date is the last day of its month it counts as day 30, and if
 *    the start day is then 30 and the end day is 31, the end day is pulled back to 30;
 *  - European: both day numbers are simply capped at 30.
 */
export function days360(startDate: DateLike, endDate: DateLike, europeanMethod = false): number {
  let start = toPlainDate(startDate);
  let end = toPlainDate(endDate);

  const order = compare(end, start);
  if (order === 0) {
    return 0;
  }
  if (order < 0) {
    [start, end] = [end, start];
  }

  let startDay = start.day;
  let endDay = end.day;

  if (europeanMethod) {
    startDay = Math.min(startDay, 30);
    endDay = Math.min(endDay, 30);
  } else {
    // US NASD
    if (isLastDay(start)) {
      startDay = 30;
    }
    if (startDay === 30 && endDay === 31) {
      endDay = 30;
    }
  }

  return (end.year - start.year) * 360 + (end.month - start.month) * 30 + (endDay - startDay);
}
