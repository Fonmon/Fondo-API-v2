import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * **Phase 8b / D48 — the host zone, measured from outside jest.**
 *
 * jest pins `TZ=UTC` in its parent process (`jest.config.ts`), and assigning `process.env.TZ`
 * inside a spec is a measured no-op. Under UTC a host-zone *year* read happens to agree with
 * Bogotá at every instant where the two years differ: those instants fall on 31 December from
 * 19:00 Bogotá on, and after 14:00 every anniversary in that year is already missed, so both
 * implementations pick year + 1. Mutant **M3** (`now.getFullYear()`) survived the whole suite for
 * that reason (`docs/phase-8b-deviations.md` §5.3).
 *
 * It is **not** equivalent for a host more than ten hours ahead of Bogotá. There the host's 1
 * January starts while Bogotá is still before 14:00 on 31 December, and a 31 December birthday
 * saved then is due *today*. So these cells load `nextBirthdayRunDate` in a child Node process
 * under a real `TZ` ahead of UTC+05, and read the answer back.
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
