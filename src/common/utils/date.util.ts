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
 * Reads the calendar parts of a `Date` that came out of a **`@db.Date` column**.
 *
 * Prisma returns `@db.Date` columns as a `Date` pinned to UTC midnight, so UTC parts are
 * the stored calendar date. Using local getters here would shift the date by a day for any
 * process running west of Greenwich — including `America/Bogota`.
 *
 * ⚠️ **This is the wrong function for a `timestamptz`.** Reviewer finding S1 / plan rule 5c:
 * v1 is not uniform about this, and picking the wrong side is invisible in CI.
 *
 * | v1 field | Prisma type | v1 serializer | v2 call |
 * |---|---|---|---|
 * | `UserFinance.last_modified`, `LoanDetail.from_date`, `Power.meeting_date` | `DateTime @db.Date` | `format_date(obj.last_modified)` — no conversion (`serializers.py:29`) | `formatDateEs(fromDateColumn(row.last_modified))` |
 * | `Loan.created_at`, `SavingAccount.created_at`, `SchedulerTask.run_date` | `DateTime @db.Timestamptz` | `format_date(timezone.localtime(obj.created_at))` (`serializers.py:88`) | `formatDateEs(toBogotaDate(row.created_at))` |
 *
 * Reading a `timestamptz` with this function yields the **next day's** calendar date for
 * every instant between 19:00 and 23:59 Bogota — roughly 21% of the day.
 */
export function fromDateColumn(value: Date): PlainDate {
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
  };
}

/**
 * Normalises a `PlainDate | Date` for the day-count helpers below.
 *
 * A `Date` is interpreted as a {@link fromDateColumn} value, which is correct for every
 * v1 caller of `days360`: `LoanDetail.from_date` and `payday_limit` are both `DateField`s
 * (`models.py:71`, `services/loan.py:299`).
 *
 * ⚠️ Not exported as a formatting entry point on purpose — see {@link fromDateColumn}.
 */
export function toPlainDate(value: DateLike): PlainDate {
  if (isPlainDate(value)) {
    return { year: value.year, month: value.month, day: value.day };
  }
  return fromDateColumn(value);
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

/**
 * DRF's `DateField.to_representation` — **ISO `YYYY-MM-DD`**, and nothing else.
 *
 * ```python
 * def to_representation(self, value):
 *     if not value: return None
 *     output_format = getattr(self, 'format', api_settings.DATE_FORMAT)   # ISO_8601
 *     if output_format is None or isinstance(value, str): return value
 *     if output_format.lower() == ISO_8601: return value.isoformat()
 *     return value.strftime(output_format)
 * ```
 *
 * ⚠️ **This is not the Spanish `format_date` spelling, and the difference is deliberate in
 * v1.** Only the fields v1 declares as a `SerializerMethodField` calling
 * `babel.dates.format_date` come out Spanish — `UserFinanceSerializer.last_modified`,
 * `LoanSerializer.created_at`, `LoanDetailSerializer.payday_limit` / `from_date`. Every
 * *plain* `ModelSerializer` date field is ISO: `UserProfileSerializer.birthdate`,
 * `PowerSerializer.meeting_date` and — Phase 5 — `ActivityDetailSerializer.date`
 * (`serializers.py:129-133`). Plan rule **5c** is about `@db.Date` vs `timestamptz`; it does
 * *not* say the spelling is uniform, and "fixing" one of these into Spanish is a divergence.
 * v1's own suite pins it: `test_activity_views.py:148` asserts `'2020-11-07'`.
 *
 * The value comes from a Prisma `@db.Date`, which is a `Date` at **UTC midnight**, so
 * {@link fromDateColumn} is the identity and reading the local components would shift the day
 * west of Greenwich.
 */
export function formatDrfDateField(value: Date | null): string | null {
  if (value === null) {
    return null;
  }
  const { year, month, day } = fromDateColumn(value);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
