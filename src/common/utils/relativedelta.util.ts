import { daysInMonth, fromDateColumn, type PlainDate } from './date.util';

/**
 * Port of the subset of `dateutil.relativedelta` v1 uses — **month-end arithmetic in
 * particular**, which is where library implementations disagree.
 *
 * v1 pins `python-dateutil==2.7.5` (`requirements.txt`) and applies it in two places:
 *
 * ```python
 * # fondo_api/scheduler/tasks.py:30-41 — create_repeat_instance
 * if task.repeat == 1: run_date = run_date + relativedelta(days=1)    # DAILY
 * if task.repeat == 2: run_date = run_date + relativedelta(weeks=1)   # WEEKLY
 * if task.repeat == 3: run_date = run_date + relativedelta(months=1)  # MONTHLY
 * if task.repeat == 4: run_date = run_date + relativedelta(years=1)   # YEARLY
 *
 * # fondo_api/services/loan.py:247,300,303 — amortisation table and payment reminders
 * payment_date    = initial_date + relativedelta(months=+i)
 * five_days_date  = payday_limit - relativedelta(days=5)
 * before_date     = payday_limit - relativedelta(days=1)
 * ```
 *
 * Phase 3 needs it before Phase 7 does: setting `birthdate` on a personal update schedules a
 * **yearly** (`repeat = 4`) `SchedulerTask` (`services/user.py:__create_birthdate_notification`).
 *
 * ## The algorithm, from `dateutil/relativedelta.py::__radd__`
 *
 * ```python
 * year  = other.year + self.years
 * month = other.month
 * if self.months:
 *     month += self.months
 *     if month > 12: year += 1; month -= 12
 *     elif month < 1: year -= 1; month += 12
 * day = min(calendar.monthrange(year, month)[1], other.day)   # <- the clamp
 * return other.replace(year=year, month=month, day=day) + timedelta(days=self.days, ...)
 * ```
 *
 * Three properties that matter and are easy to get wrong:
 *
 *  1. **The day is clamped, never rolled over.** `2018-01-31 + 1 month` is `2018-02-28`,
 *     not `2018-03-03`. (`Date.setMonth` in JS rolls over — do not use it here.)
 *  2. **Years and months are applied first, days afterwards**, as a real `timedelta`. So
 *     `weeks` and `days` never clamp; only `years`/`months` do.
 *  3. **The clamp is not reversible, so repeated application drifts.** A MONTHLY task first
 *     run on the 31st clones to the 28th and then stays on the 28th forever, because each
 *     clone is computed from the *previous clone*, not from an anchor date
 *     (`create_repeat_instance` reads `task.run_date`). Same for a leap-day YEARLY task:
 *     2020-02-29 → 2021-02-28 → 2022-02-28 → … That is v1's behaviour and v2 reproduces it.
 *
 * Every expected value in `relativedelta.util.spec.ts` was produced by running
 * `python-dateutil==2.7.5` on CPython 3.9 in a container, not derived from this code.
 */

/** The fields of `dateutil.relativedelta.relativedelta` this port supports. */
export interface RelativeDelta {
  readonly years?: number;
  readonly months?: number;
  /** Normalised into `days` by dateutil's constructor (`days + weeks * 7`). */
  readonly weeks?: number;
  readonly days?: number;
}

const MILLISECONDS_PER_DAY = 86_400_000;

/**
 * `plainDate + relativedelta(...)`.
 *
 * Pure calendar arithmetic on a `PlainDate` — the right entry point for a `@db.Date` column
 * (`LoanDetail.from_date`, `payday_limit`) and for the amortisation table's `payment_date`.
 */
export function addRelativeDelta(date: PlainDate, delta: RelativeDelta): PlainDate {
  const { years = 0, months = 0, weeks = 0, days = 0 } = delta;

  // dateutil `_fix()` folds |months| > 11 into years, which is exactly total-month
  // arithmetic; doing it directly avoids reproducing the sign-dependent divmod dance.
  const totalMonths = (date.year + years) * 12 + (date.month - 1) + months;
  const year = Math.floor(totalMonths / 12);
  const month = (totalMonths % 12) + 1;

  // `day = min(calendar.monthrange(year, month)[1], other.day)`
  const clampedDay = Math.min(daysInMonth(year, month), date.day);

  const totalDays = days + weeks * 7;
  if (totalDays === 0) {
    return { year, month, day: clampedDay };
  }

  // `+ timedelta(days=...)`, applied after the replace. UTC midnight keeps this immune to
  // the host time zone.
  const shifted = new Date(
    Date.UTC(year, month - 1, clampedDay) + totalDays * MILLISECONDS_PER_DAY,
  );
  return fromDateColumn(shifted);
}

/**
 * `instant + relativedelta(...)` for a `timestamptz` value, e.g. `SchedulerTask.run_date`.
 *
 * ⚠️ Operates on the instant's **UTC** wall clock, which is what v1 does: Django with
 * `USE_TZ = True` hands `create_repeat_instance` a UTC-aware `datetime`, and
 * `relativedelta.__radd__` calls `other.replace(...)` — it rewrites the naive fields and
 * leaves `tzinfo` untouched. Time of day, minutes, seconds and milliseconds are preserved
 * exactly, including across the month-end clamp.
 */
export function addRelativeDeltaToInstant(instant: Date, delta: RelativeDelta): Date {
  const date = addRelativeDelta(fromDateColumn(instant), delta);
  return new Date(
    Date.UTC(
      date.year,
      date.month - 1,
      date.day,
      instant.getUTCHours(),
      instant.getUTCMinutes(),
      instant.getUTCSeconds(),
      instant.getUTCMilliseconds(),
    ),
  );
}

/**
 * `SchedulerTask.repeat` (`models.py:103-109`), with the interval each value clones by.
 * `NONE` produces no clone at all (`create_repeat_instance` returns early on `repeat == 0`).
 */
export enum SchedulerRepeat {
  NONE = 0,
  DAILY = 1,
  WEEKLY = 2,
  MONTHLY = 3,
  YEARLY = 4,
}

/**
 * Whether a raw `fondo_api_schedulertask.repeat` value is one of the five Django
 * `REPEAT_TYPES`.
 *
 * ⚠️ The column is `choices`-constrained in **Python only** — there is no check constraint —
 * so an out-of-range value is a reachable database state, and v1 handles it by accident:
 * `create_repeat_instance`'s four `if`s are not `elif`s and have no `else`, so a `repeat` of,
 * say, 7 leaves `run_date` unchanged and clones the task **onto its own date**, producing an
 * unprocessed twin that repeats the trick on the next pass, forever. Phase 7b refuses
 * instead (**P7-D3**), and this is the narrowing that lets it.
 */
export function isSchedulerRepeat(value: number): value is SchedulerRepeat {
  // ⚠️ `Number.isInteger` first, and not as a formality: a numeric TS enum carries a **reverse
  // mapping**, so `hasOwnProperty(SchedulerRepeat, 'MONTHLY')` is `true`. The parameter is
  // typed `number`, but the values this narrows come out of a database column, and a guard
  // that accepts its own enum's key names is one `as` away from being useless.
  return (
    Number.isInteger(value) && Object.prototype.hasOwnProperty.call(SchedulerRepeat, String(value))
  );
}

const REPEAT_DELTAS: Readonly<Record<SchedulerRepeat, RelativeDelta | null>> = Object.freeze({
  [SchedulerRepeat.NONE]: null,
  [SchedulerRepeat.DAILY]: { days: 1 },
  [SchedulerRepeat.WEEKLY]: { weeks: 1 },
  [SchedulerRepeat.MONTHLY]: { months: 1 },
  [SchedulerRepeat.YEARLY]: { years: 1 },
});

/**
 * The `run_date` of the clone `create_repeat_instance` would write, or `null` for
 * `repeat = NONE`.
 *
 * Phase 7 owns the row-writing; this is the date arithmetic half, pinned in Phase 0 because
 * Phase 3's birthday task creates `repeat = YEARLY` rows long before Phase 7 reads them.
 */
export function nextRepeatRunDate(runDate: Date, repeat: SchedulerRepeat): Date | null {
  const delta = REPEAT_DELTAS[repeat];
  if (delta === null || delta === undefined) {
    return null;
  }
  return addRelativeDeltaToInstant(runDate, delta);
}
