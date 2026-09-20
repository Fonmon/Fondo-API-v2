import {
  BOGOTA_TIME_ZONE,
  bogotaWallClockToInstant,
  nowInstant,
  partsInZone,
  plainDateToUtcDate,
  toBogotaDate,
  todayForAutoNowDateColumn,
  todayForAutoNowDateField,
  todayInBogota,
} from './timezone.util';
import { formatDateEs } from '../i18n/spanish-format';
import { fromDateColumn, toPlainDate } from './date.util';

describe('America/Bogota time handling (Django USE_TZ = True)', () => {
  it('is a fixed UTC-05:00 zone', () => {
    const parts = partsInZone(new Date('2018-03-09T12:00:00.000Z'));
    expect(parts).toEqual({ year: 2018, month: 3, day: 9, hour: 7, minute: 0, second: 0 });
  });

  it('has no DST: July and January have the same offset', () => {
    const january = partsInZone(new Date('2018-01-15T12:00:00.000Z'));
    const july = partsInZone(new Date('2018-07-15T12:00:00.000Z'));
    expect(january.hour).toBe(7);
    expect(july.hour).toBe(7);
  });

  it('rolls the calendar day back for instants between 00:00 and 05:00 UTC', () => {
    // This is exactly what `timezone.localtime()` does before a serializer formats
    // `created_at` — a loan created at 02:00 UTC on the 10th reads as the 9th in Bogota.
    expect(toBogotaDate(new Date('2018-03-10T02:00:00.000Z'))).toEqual({
      year: 2018,
      month: 3,
      day: 9,
    });
    expect(toBogotaDate(new Date('2018-03-10T05:00:00.000Z'))).toEqual({
      year: 2018,
      month: 3,
      day: 10,
    });
  });

  it('feeds formatDateEs the localised day, not the UTC day', () => {
    const createdAt = new Date('2018-01-01T03:30:00.000Z');
    expect(formatDateEs(toBogotaDate(createdAt))).toBe('31 dic. 2017');
  });

  it('renders midnight as hour 0, never 24', () => {
    expect(partsInZone(new Date('2018-03-10T05:00:00.000Z')).hour).toBe(0);
  });

  it('round-trips a plain date through a DATE column representation', () => {
    const date = { year: 2018, month: 3, day: 28 };
    expect(toPlainDate(plainDateToUtcDate(date))).toEqual(date);
  });

  it('converts a Bogota wall clock back to the right UTC instant', () => {
    // v1: `make_aware(datetime(2017, 12, 4))` for a scheduled payment reminder.
    expect(bogotaWallClockToInstant({ year: 2017, month: 12, day: 4 }).toISOString()).toBe(
      '2017-12-04T05:00:00.000Z',
    );
    expect(
      bogotaWallClockToInstant({ year: 2017, month: 12, day: 4, hour: 10 }).toISOString(),
    ).toBe('2017-12-04T15:00:00.000Z');
  });

  it('round-trips wall clock -> instant -> wall clock', () => {
    const wall = { year: 2020, month: 2, day: 29, hour: 14, minute: 30, second: 15 };
    const instant = bogotaWallClockToInstant(wall);
    expect(partsInZone(instant)).toEqual(wall);
  });

  it('todayInBogota uses the injected clock', () => {
    expect(todayInBogota(new Date('2022-01-01T04:59:59.000Z'))).toEqual({
      year: 2021,
      month: 12,
      day: 31,
    });
  });

  it('exports the zone name Django is configured with', () => {
    expect(BOGOTA_TIME_ZONE).toBe('America/Bogota');
  });
});

/**
 * Plan §4 rule 5 / review finding S6 — the `auto_now` question, settled by running the
 * pinned stack rather than by reading `DateField.pre_save` alone.
 *
 * `DateField.pre_save` calls `datetime.date.today()`, which is process-local and ignores
 * `settings.TIME_ZONE` — but `django.conf.Settings.__init__` has already done
 * `os.environ['TZ'] = self.TIME_ZONE; time.tzset()`, so the process zone *is*
 * `America/Bogota`. Verified on `Django==2.2.27` / CPython 3.9 with the container clock at
 * `2026-08-31T00:09Z`: `date.today()` returned `2026-08-30` after `django.setup()` and
 * `2026-08-31` before it.
 */
describe('auto_now (Django DateTimeField vs DateField)', () => {
  // 2026-08-31 00:09 UTC == 2026-08-30 19:09 Bogota: inside the ~21% of the day where the
  // two calendars disagree, and the exact instant used in the verification run above.
  const insideTheWindow = new Date('2026-08-31T00:09:53.000Z');

  it('DateField(auto_now=True) writes the Bogota calendar date, as v1 does', () => {
    expect(todayForAutoNowDateField(insideTheWindow)).toEqual({
      year: 2026,
      month: 8,
      day: 30,
    });
  });

  it('is pinned to Bogota, never inherited from the host TZ', () => {
    const previousTz = process.env.TZ;
    try {
      for (const hostZone of ['UTC', 'Europe/Madrid', 'Australia/Sydney']) {
        process.env.TZ = hostZone;
        expect(todayForAutoNowDateField(insideTheWindow).day).toBe(30);
      }
    } finally {
      process.env.TZ = previousTz;
    }
  });

  it('renders the DateField value as a Prisma @db.Date at UTC midnight', () => {
    const column = todayForAutoNowDateColumn(insideTheWindow);
    expect(column.toISOString()).toBe('2026-08-30T00:00:00.000Z');
    // Round-trips through the reader Phase 3 will use for `last_modified`.
    expect(fromDateColumn(column)).toEqual({ year: 2026, month: 8, day: 30 });
  });

  it('DateTimeField(auto_now=True) writes the instant, with no calendar decision at all', () => {
    const before = Date.now();
    const value = nowInstant().getTime();
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(Date.now());
  });

  it('the two halves disagree by a day inside the window — which is the whole point', () => {
    // `Loan.created_at` (timestamptz) and `LoanDetail.from_date` (DateField) written in the
    // same request at 19:09 Bogota: the instant is the 31st in UTC, the date is the 30th.
    expect(insideTheWindow.getUTCDate()).toBe(31);
    expect(todayForAutoNowDateField(insideTheWindow).day).toBe(30);
  });

  /**
   * ## B2 / B3 — `Date.UTC` remaps years 0-99, and one site was reachable through the offset pass
   *
   * ⚠️ **Enumerate the candidate wrong implementations first, then control against each
   * separately** (the standing rule C76 taught, sharpened by `nestjs-reviewer` after C76's own
   * failure turned out to be an incomplete enumeration rather than an absent mutation). There
   * are **three** distinct wrong implementations here, not one:
   *
   * | mutant | what it is | caught only by |
   * |---|---|---|
   * | **M-a** `plainDateToUtcDate` back to raw `Date.UTC` | the stored value bug | year-50 / year-1 cells |
   * | **M-b** `bogotaWallClockToInstant`'s `asUtc` back to raw `Date.UTC` | the task `run_date` bug | year-50 wall-clock cell |
   * | **M-c** `zonedTimeToUtcMillis` back to raw `Date.UTC` | **B3** | the `0100-01-01` cell **only** |
   *
   * **M-c is the reason this block exists in this shape.** A fix to M-a and M-b alone passes
   * every year-50 cell and still produces year **-1800** for `0100-01-01`, so a round that
   * tested only the obvious years would have reported green on a live 500. Each cell below
   * names the mutant it was measured against; do not delete one because another looks similar.
   */
  describe('B2/B3 - years 0-99 and the offset-correction pass', () => {
    it('M-a: a two-digit year survives plainDateToUtcDate instead of gaining 1900', () => {
      // Raw `Date.UTC(50, 5, 15)` is 1950-06-15. v1 stores 0050-06-15 and answers 200, so the
      // divergence was silent on both sides -- the tester found it only by reading the row.
      expect(plainDateToUtcDate({ year: 50, month: 6, day: 15 }).toISOString()).toBe(
        '0050-06-15T00:00:00.000Z',
      );
      expect(plainDateToUtcDate({ year: 1, month: 1, day: 1 }).toISOString()).toBe(
        '0001-01-01T00:00:00.000Z',
      );
      expect(plainDateToUtcDate({ year: 99, month: 12, day: 31 }).toISOString()).toBe(
        '0099-12-31T00:00:00.000Z',
      );
    });

    it('M-a: years at and either side of the remap window are untouched', () => {
      // The boundary matters in both directions: 100 and 1900 must not be "corrected" either.
      expect(plainDateToUtcDate({ year: 100, month: 1, day: 1 }).toISOString()).toBe(
        '0100-01-01T00:00:00.000Z',
      );
      expect(plainDateToUtcDate({ year: 1900, month: 1, day: 1 }).toISOString()).toBe(
        '1900-01-01T00:00:00.000Z',
      );
      expect(plainDateToUtcDate({ year: 2026, month: 9, day: 8 }).toISOString()).toBe(
        '2026-09-08T00:00:00.000Z',
      );
    });

    it('M-b: a two-digit year survives the wall-clock conversion', () => {
      // Bogota ran on LMT (-04:56:16) until 1914, so the expected instant is not a round -05:00
      // offset. Taken from the conversion itself rather than assumed, then checked for the one
      // property that matters: the YEAR is 50, not 1950.
      const instant = bogotaWallClockToInstant({ year: 50, month: 6, day: 15 });
      expect(instant.getUTCFullYear()).toBe(50);
      expect(partsInZone(instant, BOGOTA_TIME_ZONE).year).toBe(50);
    });

    it('M-c (B3): 0100-01-01 does not fall through the offset pass into year -1800', () => {
      // ⚠️ THE DISCRIMINATING CELL. The input year (100) is OUTSIDE the remap window, so M-a
      // and M-b are both clean here. What fires is `zonedTimeToUtcMillis`: the Bogota-local
      // year falls back to 99, the remap turns that into 1999, and the offset correction
      // becomes -1900 years -- yielding -001800-01-02T04:56:16Z, which PostgreSQL rejects with
      // 22009 and which the tester misread as "year 100 out of range". It is not; PostgreSQL
      // stores year 100 fine. Restore raw `Date.UTC` in `zonedTimeToUtcMillis` and only this
      // cell fails.
      const instant = bogotaWallClockToInstant({ year: 100, month: 1, day: 1 });
      expect(instant.getUTCFullYear()).toBe(100);
      expect(instant.toISOString().startsWith('-')).toBe(false);
      expect(partsInZone(instant, BOGOTA_TIME_ZONE)).toMatchObject({ year: 100, month: 1, day: 1 });
    });

    it('M-c: the same fall-back shape one year later, as a control on the cell above', () => {
      // 0101-01-01's Bogota-local year is 100, which is NOT in the remap window -- so this one
      // passes even with the bug. It is here to prove the cell above is pinned on the remap and
      // not on "old years are broken generally".
      expect(bogotaWallClockToInstant({ year: 101, month: 1, day: 1 }).getUTCFullYear()).toBe(101);
    });
  });
});
