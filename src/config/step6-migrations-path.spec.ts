import {
  DEFAULT_MIGRATIONS_PATH,
  MIGRATIONS_PATH_VAR,
  resolveMigrationsPath,
  STEP6_CONFIRM_VAR,
  Step6ConfirmationError,
  todayInBogotaIso,
} from './step6-migrations-path';

/**
 * The two-variable gate on the Phase 9 step-6 ledger — condition **C96**.
 *
 * The cells that matter are the refusals. A warning-only version of this shipped first and
 * the reviewer's objection was precise: a `PRISMA_MIGRATIONS_PATH` left in a task definition
 * converts production on a routine deploy, and Release A's own guard then refuses to start —
 * door fired, service down, rollback dead, nobody watching.
 */
describe('resolveMigrationsPath', () => {
  const TODAY = '2026-09-15';
  const STEP6 = 'prisma/migrations-step6';

  describe('the default ledger needs no confirmation', () => {
    it('resolves the default when the variable is unset', () => {
      const result = resolveMigrationsPath({}, TODAY);
      expect(result.path).toBe(DEFAULT_MIGRATIONS_PATH);
      expect(result.level).toBe('info');
    });

    it('resolves the default when the variable is pinned to it — test-database.ts does this', () => {
      const result = resolveMigrationsPath(
        { [MIGRATIONS_PATH_VAR]: DEFAULT_MIGRATIONS_PATH },
        TODAY,
      );
      expect(result.path).toBe(DEFAULT_MIGRATIONS_PATH);
      expect(result.level).toBe('info');
      // ⚠️ and it does NOT demand a confirmation, or every e2e run would need one.
    });

    it('logs the resolved path even on the default, so a leftover is visible either way', () => {
      expect(resolveMigrationsPath({}, TODAY).message).toContain(DEFAULT_MIGRATIONS_PATH);
    });
  });

  describe('a non-default ledger is refused unless confirmed for today', () => {
    it('MISSING: refuses when STEP6_CONFIRM is not set', () => {
      expect(() => resolveMigrationsPath({ [MIGRATIONS_PATH_VAR]: STEP6 }, TODAY)).toThrow(
        Step6ConfirmationError,
      );
      expect(() => resolveMigrationsPath({ [MIGRATIONS_PATH_VAR]: STEP6 }, TODAY)).toThrow(
        /is not set/,
      );
    });

    it('MISSING: an empty string is not a confirmation', () => {
      expect(() =>
        resolveMigrationsPath({ [MIGRATIONS_PATH_VAR]: STEP6, [STEP6_CONFIRM_VAR]: '' }, TODAY),
      ).toThrow(/is not set/);
    });

    it('STALE: refuses yesterday — the leftover-variable case', () => {
      expect(() =>
        resolveMigrationsPath(
          { [MIGRATIONS_PATH_VAR]: STEP6, [STEP6_CONFIRM_VAR]: '2026-09-14' },
          TODAY,
        ),
      ).toThrow(/is not today in America\/Bogota \(2026-09-15\)/);
    });

    it('STALE: refuses a future date too — a pre-filled confirmation is the same hazard', () => {
      expect(() =>
        resolveMigrationsPath(
          { [MIGRATIONS_PATH_VAR]: STEP6, [STEP6_CONFIRM_VAR]: '2026-12-01' },
          TODAY,
        ),
      ).toThrow(/is not today in America\/Bogota/);
    });

    it.each([
      ['2026-9-15', 'a single-digit month'],
      ['15-09-2026', 'the wrong field order'],
      [' 2026-09-15', 'a leading space'],
      ['2026-09-15 ', 'a trailing space'],
      ['2026-09-15T00:00:00Z', 'a timestamp'],
      ['today', 'a word'],
      ['true', 'a boolean, as if this were a flag'],
    ])('MALFORMED: refuses %p (%s)', (value) => {
      expect(() =>
        resolveMigrationsPath({ [MIGRATIONS_PATH_VAR]: STEP6, [STEP6_CONFIRM_VAR]: value }, TODAY),
      ).toThrow(/is not a YYYY-MM-DD date/);
    });

    it('CORRECT: accepts today, and still logs a WARNING naming the ledger', () => {
      const result = resolveMigrationsPath(
        { [MIGRATIONS_PATH_VAR]: STEP6, [STEP6_CONFIRM_VAR]: TODAY },
        TODAY,
      );
      expect(result.path).toBe(STEP6);
      expect(result.level).toBe('warn');
      expect(result.message).toContain('ONE-WAY');
      expect(result.message).toContain(STEP6);
    });

    it('every refusal tells the operator the exact command, including the Bogotá date', () => {
      for (const confirmation of [undefined, '2026-09-14', 'nope']) {
        const env = {
          [MIGRATIONS_PATH_VAR]: STEP6,
          ...(confirmation === undefined ? {} : { [STEP6_CONFIRM_VAR]: confirmation }),
        };
        expect(() => resolveMigrationsPath(env, TODAY)).toThrow(
          /STEP6_CONFIRM=\$\(TZ=America\/Bogota date \+%F\)/,
        );
      }
    });
  });

  describe('todayInBogotaIso', () => {
    it('is the Bogotá calendar date, not the host’s', () => {
      // 2026-09-16T02:00Z is still 2026-09-15 at 21:00 in Bogotá (UTC−5).
      expect(todayInBogotaIso(new Date('2026-09-16T02:00:00Z'))).toBe('2026-09-15');
      expect(todayInBogotaIso(new Date('2026-09-15T05:00:00Z'))).toBe('2026-09-15');
      // ⚠️ This is the hazard the zone pin exists for: a `date +%F` on a UTC host after
      // 19:00 Bogotá already reads tomorrow, and the gate would refuse a correct operator.
      expect(todayInBogotaIso(new Date('2026-09-16T02:00:00Z'))).not.toBe('2026-09-16');
    });

    it('zero-pads month and day', () => {
      expect(todayInBogotaIso(new Date('2026-01-05T12:00:00Z'))).toBe('2026-01-05');
    });
  });
});
