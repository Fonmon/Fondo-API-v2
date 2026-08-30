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
 *     date (see `toPlainDate` in `date.util.ts`).
 *
 * `America/Bogota` is a fixed UTC-05:00 zone with no DST and no scheduled transitions, but
 * the offset is resolved through `Intl` rather than hardcoded so a future tzdata change
 * cannot silently corrupt dates.
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
