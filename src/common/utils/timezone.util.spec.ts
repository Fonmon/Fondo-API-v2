import {
  BOGOTA_TIME_ZONE,
  bogotaWallClockToInstant,
  partsInZone,
  plainDateToUtcDate,
  toBogotaDate,
  todayInBogota,
} from './timezone.util';
import { formatDateEs } from '../i18n/spanish-format';
import { toPlainDate } from './date.util';

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
