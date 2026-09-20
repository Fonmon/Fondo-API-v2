import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { PlainDate } from '../common/utils/date.util';
import { BOGOTA_TIME_ZONE, partsInZone, type ZonedParts } from '../common/utils/timezone.util';
import { LAST_SCHEDULER_PASS_HOUR } from '../scheduler/scheduler-passes';
import { birthdayInYear, nextBirthdayRunDate } from './birthday-run-date';

/**
 * **Phase 8b / D48 — the host zone, measured from outside jest.**
 *
 * jest pins `TZ=UTC` in its parent process (`jest.config.ts`), and assigning `process.env.TZ`
 * inside a spec is a measured no-op. So a host-zone *year* read (mutant **M3**,
 * `now.getFullYear()`) is exercised here in two ways:
 *
 *  * **Which host offsets make M3 disagree with D48** is not asserted in prose. The sweep below
 *    models M3's exact diff for a fixed-offset host, and checks every birthday of a leap year at
 *    every quarter-hour instant from 30 December 12:00 to 1 January 12:00 Bogotá, for every
 *    quarter-hour offset from UTC−12:00 to UTC+14:00. It asserts the offsets with any
 *    disagreement are **exactly those above UTC+05:00**. Resolution: quarter hours, both axes;
 *    offsets between grid points are not checked.
 *  * **That a real zone behaves like its offset** is checked in a child Node process under a real
 *    `TZ` (`Asia/Tokyo`, `Pacific/Kiritimati`), because only there does `getFullYear()` read a
 *    zone other than UTC. Those cells killed M3 in the Phase 8b mutation run, where the in-jest
 *    suite under UTC had let it survive (`docs/phase-8b-deviations.md` §5.3).
 *
 * Each child also reports its own `getFullYear()` and resolved zone. That is the positive
 * control: if the `TZ` did not take effect, the cell fails on the control rather than passing on
 * a UTC host.
 */
const REPO_ROOT = resolve(__dirname, '..', '..');
const MODULE_PATH = resolve(__dirname, 'birthday-run-date.ts');

interface ChildReading {
  zone: string;
  hostYear: number;
  runDate: { year: number; month: number; day: number };
}

function runUnderZone(
  zone: string,
  birthdate: { year: number; month: number; day: number },
  nowIso: string,
): ChildReading {
  const script = [
    `const { nextBirthdayRunDate } = require(${JSON.stringify(MODULE_PATH)});`,
    `const now = new Date(${JSON.stringify(nowIso)});`,
    'process.stdout.write(JSON.stringify({',
    '  zone: Intl.DateTimeFormat().resolvedOptions().timeZone,',
    '  hostYear: now.getFullYear(),',
    `  runDate: nextBirthdayRunDate(${JSON.stringify(birthdate)}, now),`,
    '}));',
  ].join('\n');
  const output = execFileSync(process.execPath, ['-r', 'ts-node/register', '-e', script], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      TZ: zone,
      TS_NODE_TRANSPILE_ONLY: 'true',
      TS_NODE_PROJECT: resolve(REPO_ROOT, 'tsconfig.json'),
      // Without an explicit `rootDir`, ts-node stops on config diagnostic TS5011 before loading
      // the module, even in transpile-only mode. Measured: all three cells failed that way on
      // the unmutated tree, before this line was added.
      TS_NODE_COMPILER_OPTIONS: JSON.stringify({ rootDir: REPO_ROOT }),
    },
  });
  return JSON.parse(output) as ChildReading;
}

describe('nextBirthdayRunDate under a real host zone ahead of Bogotá (D48, mutant M3)', () => {
  /** 2026-12-31 10:00 Bogotá = 2026-12-31T15:00Z = 2027-01-01 00:00 Tokyo = 05:00 Kiritimati. */
  const NEW_YEARS_EVE_MORNING_BOGOTA = '2026-12-31T15:00:00.000Z';

  it.each(['Asia/Tokyo', 'Pacific/Kiritimati'])(
    'under TZ=%s, a 31 December birthday saved at 10:00 on 31 December Bogotá is due today',
    (zone) => {
      const reading = runUnderZone(
        zone,
        { year: 1990, month: 12, day: 31 },
        NEW_YEARS_EVE_MORNING_BOGOTA,
      );

      // Positive control: the child really is on a host whose year has already turned.
      expect(reading.zone).toBe(zone);
      expect(reading.hostYear).toBe(2027);
      // The decision: Bogotá's 31 December, with the 14:00 pass still to run.
      expect(reading.runDate).toEqual({ year: 2026, month: 12, day: 31 });
    },
    30_000,
  );

  it('under TZ=Asia/Tokyo, a 1 January birthday saved at the same instant is tomorrow in Bogotá', () => {
    const reading = runUnderZone(
      'Asia/Tokyo',
      { year: 1990, month: 1, day: 1 },
      NEW_YEARS_EVE_MORNING_BOGOTA,
    );

    expect(reading.hostYear).toBe(2027);
    expect(reading.runDate).toEqual({ year: 2027, month: 1, day: 1 });
  }, 30_000);
});

/**
 * M3's diff, applied to a host at a fixed UTC offset. It is a transcription of the mutant, not a
 * second implementation of D48:
 *
 * ```diff
 * - const thisYear = birthdayInYear(birthdate, wall.year);
 * + const thisYear = birthdayInYear(birthdate, now.getFullYear());
 * - return birthdayInYear(birthdate, wall.year + 1);
 * + return birthdayInYear(birthdate, now.getFullYear() + 1);
 * ```
 */
function m3OnFixedOffsetHost(birthdate: PlainDate, wall: ZonedParts, hostYear: number): PlainDate {
  const thisYear = birthdayInYear(birthdate, hostYear);
  const order = thisYear.year - wall.year || thisYear.month - wall.month || thisYear.day - wall.day;
  if (order > 0) {
    return thisYear;
  }
  if (order === 0 && wall.hour < LAST_SCHEDULER_PASS_HOUR) {
    return thisYear;
  }
  return birthdayInYear(birthdate, hostYear + 1);
}

describe('which host offsets make a host-zone year read disagree with D48 (M3, review n2)', () => {
  const QUARTER_HOUR_MS = 15 * 60 * 1000;
  /** 2026-12-30 12:00 Bogotá. */
  const START_MS = new Date('2026-12-30T17:00:00.000Z').getTime();
  /** 2027-01-01 12:00 Bogotá, inclusive. */
  const END_MS = new Date('2027-01-01T17:00:00.000Z').getTime();

  it('disagrees exactly for offsets above UTC+05:00, over every birthday, quarter-hour grid', () => {
    const birthdays: PlainDate[] = [];
    for (let day = 0; day < 366; day += 1) {
      const d = new Date(new Date('2000-01-01T00:00:00.000Z').getTime() + day * 86_400_000);
      birthdays.push({ year: 2000, month: d.getUTCMonth() + 1, day: d.getUTCDate() });
    }

    const instants: { now: Date; wall: ZonedParts; d48: PlainDate[] }[] = [];
    for (let ms = START_MS; ms <= END_MS; ms += QUARTER_HOUR_MS) {
      const now = new Date(ms);
      instants.push({
        now,
        wall: partsInZone(now, BOGOTA_TIME_ZONE),
        d48: birthdays.map((birthdate) => nextBirthdayRunDate(birthdate, now)),
      });
    }

    const disagreeing: number[] = [];
    let checked = 0;
    for (let quarters = -12 * 4; quarters <= 14 * 4; quarters += 1) {
      const offsetMs = quarters * QUARTER_HOUR_MS;
      let differs = false;
      for (const { now, wall, d48 } of instants) {
        const hostYear = new Date(now.getTime() + offsetMs).getUTCFullYear();
        for (let i = 0; i < birthdays.length; i += 1) {
          checked += 1;
          const m3 = m3OnFixedOffsetHost(birthdays[i], wall, hostYear);
          if (m3.year !== d48[i].year || m3.month !== d48[i].month || m3.day !== d48[i].day) {
            differs = true;
          }
        }
      }
      if (differs) {
        disagreeing.push(quarters);
      }
    }

    // The grid really is the one described: 105 offsets (−48…+56 quarters) × 193 instants × 366
    // birthdays. An earlier draft said 109 offsets; this check caught the arithmetic.
    expect(instants).toHaveLength(193);
    expect(checked).toBe(105 * 193 * 366);
    // UTC+05:15 (21 quarters) through UTC+14:00 (56 quarters), and nothing else.
    const expected = Array.from({ length: 56 - 21 + 1 }, (_, i) => 21 + i);
    expect(disagreeing).toEqual(expected);
  }, 60_000);

  /** Positive control for the model: the child-process case above, reproduced in-process. */
  it('the model reproduces the Tokyo disagreement the child process measures', () => {
    const now = new Date('2026-12-31T15:00:00.000Z');
    const birthdate = { year: 1990, month: 12, day: 31 };
    const tokyoYear = new Date(now.getTime() + 9 * 3_600_000).getUTCFullYear();

    expect(tokyoYear).toBe(2027);
    expect(nextBirthdayRunDate(birthdate, now)).toEqual({ year: 2026, month: 12, day: 31 });
    expect(m3OnFixedOffsetHost(birthdate, partsInZone(now, BOGOTA_TIME_ZONE), tokyoYear)).toEqual({
      year: 2027,
      month: 12,
      day: 31,
    });
  });
});
