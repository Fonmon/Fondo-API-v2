import type { PlainDate } from './date.util';

/**
 * `America/Bogota` calendar helpers, reproducing Django's `USE_TZ = True` +
 * `TIME_ZONE = 'America/Bogota'` semantics.
 *
 * How v1 behaves:
 *   - `DateTimeField` columns are `timestamptz` and are stored in UTC;
 *   - `django.utils.timezone.localtime(value)` converts to `America/Bogota` before a
 *     serializer renders it (`LoanSerializer.get_created_at`,
 *     `SavingAccountSerializer.get_created_at`);
 *   - `DateField` columns carry no timezone at all and must be read as a plain calendar
 *     date (see `fromDateColumn` in `date.util.ts`).
 *
 * `America/Bogota` is a fixed UTC-05:00 zone with no DST and no scheduled transitions, but
 * the offset is resolved through `Intl` rather than hardcoded so a future tzdata change
 * cannot silently corrupt dates.
 *
 * ## Writing `auto_now` values — the two halves are different (plan §4 rule 5, review S6)
 *
 * Django 2.2 `django/db/models/fields/__init__.py`:
 *
 * ```python
 * class DateTimeField(DateField):
 *     def pre_save(self, model_instance, add):
 *         if self.auto_now or (self.auto_now_add and add):
 *             value = timezone.now()          # tz-aware UTC instant
 *
 * class DateField(DateTimeCheckMixin, Field):
 *     def pre_save(self, model_instance, add):
 *         if self.auto_now or (self.auto_now_add and add):
 *             value = datetime.date.today()   # PROCESS-LOCAL calendar date
 * ```
 *
 * `datetime.date.today()` reads the **process** time zone and ignores `settings.TIME_ZONE`
 * — but that does not mean v1 writes UTC dates, because Django itself sets the process zone
 * from the setting. `django/conf/__init__.py::Settings.__init__` ends with:
 *
 * ```python
 * if hasattr(time, 'tzset') and self.TIME_ZONE:
 *     ...
 *     os.environ['TZ'] = self.TIME_ZONE
 *     time.tzset()
 * ```
 *
 * **Verified, not assumed** (`Django==2.2.27` on CPython 3.9, container `TZ` unset so the
 * host zone was UTC, wall clock `2026-08-31T00:09Z` = `2026-08-30 19:09` Bogota):
 *
 * ```
 * before django.setup():  time.tzname ('UTC','UTC')  date.today() 2026-08-31
 * after  django.setup():  time.tzname ('-05','-05')  date.today() 2026-08-30
 * ```
 *
 * So **v1 has been writing Bogota dates all along** for `UserFinance.last_modified`
 * (`models.py:32`, `DateField(auto_now=True)`) and `LoanDetail.from_date` (`models.py:71`,
 * `DateField(default=date.today)`), and v2 reproduces that with
 * {@link todayForAutoNowDateField}. There is nothing to "fix" and no next-day rows to
 * reconcile.
 *
 * ⚠️ **Residual, recorded rather than guessed:** v1's repo contains no Dockerfile — the
 * image is built by an out-of-repo `entrypoint_deploy` on the EC2 host — so the base image
 * cannot be read from source. The conclusion above holds for any image that ships tzdata,
 * which both `python:3.9-slim` and `python:3.9-alpine` do (both verified). With
 * `/usr/share/zoneinfo` deleted, `tzset()` cannot resolve the zone and `date.today()` falls
 * back to UTC (also verified) — Django does not raise, because its own validation is
 * skipped when the zoneinfo directory is absent. That is the only scenario in which v1's
 * stored dates would be UTC.
 */
export const BOGOTA_TIME_ZONE = 'America/Bogota';

const isoPartsFormatter = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = isoPartsFormatter.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    isoPartsFormatter.set(timeZone, formatter);
  }
  return formatter;
}

/** Wall-clock parts of an instant, as observed in `timeZone`. */
export interface ZonedParts extends PlainDate {
  hour: number;
  minute: number;
  second: number;
}

/** Decomposes an instant into the wall-clock parts seen in `timeZone`. */
export function partsInZone(instant: Date, timeZone: string = BOGOTA_TIME_ZONE): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    if (part === undefined) {
      throw new Error(`Intl did not produce a "${type}" part for time zone ${timeZone}`);
    }
    return Number(part.value);
  };
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    // `hour12: false` still renders midnight as 24 in some ICU builds.
    hour: read('hour') % 24,
    minute: read('minute'),
    second: read('second'),
  };
}

/**
 * The calendar date an instant falls on in `America/Bogota`.
 * This is the v2 equivalent of `django.utils.timezone.localtime(value).date()`.
 */
export function toBogotaDate(instant: Date, timeZone: string = BOGOTA_TIME_ZONE): PlainDate {
  const { year, month, day } = partsInZone(instant, timeZone);
  return { year, month, day };
}

/** "Today" in `America/Bogota`. */
export function todayInBogota(now: Date = new Date(), timeZone = BOGOTA_TIME_ZONE): PlainDate {
  return toBogotaDate(now, timeZone);
}

/**
 * The value Django writes into a `DateTimeField(auto_now=True)` /
 * `auto_now_add=True` column — `django.utils.timezone.now()`, i.e. the current instant.
 *
 * Timezone-agnostic by construction: `timestamptz` stores an instant, so there is no
 * calendar-date decision to get wrong here. Exists so that the *other* half
 * ({@link todayForAutoNowDateField}) is visibly a different operation rather than the same
 * one written twice.
 *
 * v1 columns: `Loan.created_at`, `Activity.created_at`, `SavingAccount.created_at`
 * (`models.py:55`, `:123`, `:141`).
 */
export function nowInstant(): Date {
  return new Date();
}

/**
 * The value Django writes into a `DateField(auto_now=True)` or `DateField(default=date.today)`
 * column — `datetime.date.today()` under the process time zone, which
 * `django.conf.Settings.__init__` has pinned to `settings.TIME_ZONE` via `os.environ['TZ']`
 * + `time.tzset()`. See this module's header for the verification run.
 *
 * **Pinned to `America/Bogota` explicitly**, never inherited from the host: a v2 container
 * started with `TZ=UTC` must still write the same date v1 writes, and a v2 container in a
 * third zone must not write a third answer.
 *
 * v1 columns: `UserFinance.last_modified` (`models.py:32` — rendered into the user response
 * by `serializers.py:29`, so it is user-visible) and `LoanDetail.from_date` (`models.py:71`).
 *
 * @param now injectable clock; tests pass a fixed instant.
 */
export function todayForAutoNowDateField(
  now: Date = new Date(),
  timeZone: string = BOGOTA_TIME_ZONE,
): PlainDate {
  return toBogotaDate(now, timeZone);
}

/**
 * {@link todayForAutoNowDateField} rendered the way Prisma wants a `@db.Date` value: a
 * `Date` at UTC midnight. This is the call a Phase 3/4 write path makes.
 */
export function todayForAutoNowDateColumn(now: Date = new Date()): Date {
  return plainDateToUtcDate(todayForAutoNowDateField(now));
}

/**
 * Renders a plain date the way PostgreSQL/Prisma expect a `DATE` column: a `Date` pinned to
 * UTC midnight. Reading it back with `toPlainDate` returns the same calendar day in every
 * server time zone.
 */
export function plainDateToUtcDate(date: PlainDate): Date {
  return new Date(Date.UTC(date.year, date.month - 1, date.day));
}

/**
 * The UTC instant corresponding to a `America/Bogota` wall-clock time.
 *
 * v1 builds naive datetimes and hands them to `django.utils.timezone.make_aware`, which
 * interprets them in `settings.TIME_ZONE` (`NotificationService.schedule_notification`).
 * This is that operation.
 */
export function bogotaWallClockToInstant(
  parts: PlainDate & Partial<Pick<ZonedParts, 'hour' | 'minute' | 'second'>>,
  timeZone: string = BOGOTA_TIME_ZONE,
): Date {
  const { year, month, day, hour = 0, minute = 0, second = 0 } = parts;
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  // Resolve the offset at that instant, then correct. One correction pass is enough for a
  // zone with no sub-hour DST edge cases; Bogota has had a fixed -05:00 offset since 1993.
  const firstGuess = new Date(asUtc);
  const offsetMs = asUtc - zonedTimeToUtcMillis(firstGuess, timeZone);
  return new Date(asUtc + offsetMs);
}

function zonedTimeToUtcMillis(instant: Date, timeZone: string): number {
  const parts = partsInZone(instant, timeZone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}
