import type { PlainDate } from '../common/utils/date.util';
import { BOGOTA_TIME_ZONE, partsInZone } from '../common/utils/timezone.util';
import { LAST_SCHEDULER_PASS_HOUR } from '../scheduler/scheduler-passes';

/**
 * **Phase 8b.** The birthday task's run date, as pure functions with no Nest or Prisma import.
 *
 * Moved out of `user.service.ts` (which re-exports both) so that
 * `birthday-run-date.host-zone.spec.ts` can load it in a child process under a real `TZ`. jest
 * pins its own host zone to UTC, and assigning `process.env.TZ` inside a spec is a measured no-op.
 * A host-zone read that happens to agree with Bogotá under UTC therefore can only be caught from
 * outside the jest process (mutant M3, `docs/phase-8b-deviations.md` §5.3).
 */

/**
 * `birthdate.replace(year=today_year)` with **D19**'s clamp.
 *
 * 29 February exists only in a leap year; `.replace` raises `ValueError` in every other one.
 * v2 moves the notification to **28 February**, which is where `relativedelta(years=+1)` —
 * and therefore Phase 7's own yearly clone of this very task — puts it.
 */
export function birthdayInYear(birthdate: PlainDate, year: number): PlainDate {
  if (birthdate.month === 2 && birthdate.day === 29 && !isLeapYear(year)) {
    return { year, month: 2, day: 28 };
  }
  return { year, month: birthdate.month, day: birthdate.day };
}

/**
 * **D48 (Q47, condition C71).** The run date of a birthday task written at `now`: the next
 * anniversary that has not been missed.
 *
 * ```
 * anniversary this year  > today (Bogotá)                              -> this year
 * anniversary this year == today, Bogotá wall clock < 14:00:00.000     -> this year
 * otherwise                                                            -> next year
 * ```
 *
 * v1 writes `birthdate.replace(year=today_year)` unconditionally. Once the birthday has passed
 * that date is gone. v1's exact-day selection never sends it, so the chain is dead until the
 * next edit. Under v2's D7 `<=` the same row would be sent on the next pass, saying
 * *"Hoy está cumpliendo años X"* on the wrong day.
 *
 * ## "A pass is still to run" means strictly before 14:00:00.000 Bogotá
 *
 * The passes are `0 10,14 * * *` in `America/Bogota` ({@link LAST_SCHEDULER_PASS_HOUR}).
 * A task written at **14:00:00.000 or later** goes to next year; one written at
 * **13:59:59.999** stays on today. At 14:00:00.000 the last pass has been *triggered*, and
 * whether its read has already run is not knowable from here, so "still to run" is not promised
 * from that instant on (`docs/phase-8b-deviations.md` §2.1).
 *
 * ⚠️ **Residual:** a save that reads the clock before 14:00 but commits after the 14:00 pass has
 * read its rows is not seen by that pass. D7's `<=` sends it at 10:00 the next day, one day
 * late, still saying *"hoy"*. The window is one transaction's duration. Registered in §2.1 of
 * the same document, alongside the scheduler-outage residual the plan already records.
 *
 * ## D19 applies to whichever year is chosen
 *
 * Both candidates go through {@link birthdayInYear}, so 29 February becomes 28 February in a
 * non-leap *chosen* year and stays 29 February in a leap one. The comparison with today uses
 * the clamped date: a 29 Feb member on 28 Feb of a non-leap year has their birthday today.
 *
 * ## The zone is read once, from the instant
 *
 * Today's date and the wall-clock hour come from one {@link partsInZone} call. Mutants that
 * read either half in another zone are listed, with results, in `docs/phase-8b-deviations.md` §5.
 */
export function nextBirthdayRunDate(
  birthdate: PlainDate,
  now: Date,
  timeZone: string = BOGOTA_TIME_ZONE,
): PlainDate {
  const wall = partsInZone(now, timeZone);
  const thisYear = birthdayInYear(birthdate, wall.year);
  const order = comparePlainDates(thisYear, wall);
  if (order > 0) {
    return thisYear;
  }
  if (order === 0 && wall.hour < LAST_SCHEDULER_PASS_HOUR) {
    return thisYear;
  }
  return birthdayInYear(birthdate, wall.year + 1);
}

function comparePlainDates(a: PlainDate, b: PlainDate): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}
