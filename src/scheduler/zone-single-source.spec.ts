import { BOGOTA_TIME_ZONE } from '../common/utils/timezone.util';
import type { PlainDate } from '../common/utils/date.util';
import type { AppConfigService } from '../config/app-config.service';
import { EnvValidationError, validateEnv } from '../config/env.validation';
import { nextBirthdayRunDate } from '../users/birthday-run-date';
import type { ExecuterFactory } from './executers/executer.factory';
import type { SchedulerTaskRepository } from './scheduler-task.repository';
import { SchedulerRunner } from './scheduler.runner';

/**
 * **Condition C89 (Phase 8b review m2): one zone decides where a birthday task is written, which
 * day the runner selects, and when the cron fires.**
 *
 * The three read the zone from different places:
 *
 *  * **write**: `nextBirthdayRunDate`'s default argument, the constant `BOGOTA_TIME_ZONE`;
 *  * **selection**: `SchedulerRunner.run` → `todayInBogota(now, config.timeZone)`, i.e.
 *    `TIME_ZONE` from the environment;
 *  * **cron**: the `@Cron` decorator's `timeZone`, the constant again, fixed at class definition.
 *
 * The chosen resolution is to pin `TIME_ZONE` in the schema (`env.schema.ts`), so the environment
 * cannot name a zone the constants do not. These cells fail if that stops being true in any of the
 * three directions.
 */
// ⚠️ **C90 (N2) — a placeholder credential and a database name that is not the shared one.**
// `validateEnv` never connects; it only parses. Copying the real dev URL into a seventh spec
// made the literal look load-bearing and put a working credential one copy-paste away from a
// script that *does* connect.
const MINIMAL_ENV = {
  DATABASE_URL: 'postgresql://user:password@localhost:5432/example_db?schema=public',
  AWS_REGION: 'us-east-2',
  DEFAULT_FROM_EMAIL: 'Fondo Montanez <no-reply@fonmon.minagle.com>',
  HOST_URL_APP: 'http://localhost:3000',
};

describe('one zone for write, selection and cron (C89)', () => {
  describe('the environment cannot name another zone', () => {
    it('defaults TIME_ZONE to the constant every other date decision uses', () => {
      expect(validateEnv({ ...MINIMAL_ENV }).TIME_ZONE).toBe(BOGOTA_TIME_ZONE);
    });

    it('accepts America/Bogota given explicitly', () => {
      expect(validateEnv({ ...MINIMAL_ENV, TIME_ZONE: 'America/Bogota' }).TIME_ZONE).toBe(
        BOGOTA_TIME_ZONE,
      );
    });

    /**
     * `America/Lima` is on the list on purpose: it is UTC−05:00 with no DST today, so a check by
     * offset would accept it. The pin is by name, because a future tzdata change to one zone and
     * not the other would otherwise split the calendars again.
     */
    it.each(['UTC', 'America/Lima', 'america/bogota', ' America/Bogota', 'Etc/GMT+5', ''])(
      'refuses TIME_ZONE=%j at boot',
      (zone) => {
        expect(() => validateEnv({ ...MINIMAL_ENV, TIME_ZONE: zone })).toThrow(EnvValidationError);
      },
    );
  });

  describe('the three decisions use that one zone', () => {
    const env = validateEnv({ ...MINIMAL_ENV });

    it('the cron fires in the configured zone', () => {
      const handler = Object.getOwnPropertyDescriptor(SchedulerRunner.prototype, 'handleCron')
        ?.value as object;
      const options = Reflect.getMetadata('SCHEDULE_CRON_OPTIONS', handler) as {
        timeZone: string;
      };

      expect(options.timeZone).toBe(env.TIME_ZONE);
    });

    /**
     * The instants are chosen where a different zone would decide differently:
     *
     *  * 13:30 Bogotá is 18:30 UTC, so an hour read elsewhere crosses the 14:00 cutoff;
     *  * 21:30 Bogotá is already the next day in UTC, so a date read elsewhere is a day ahead.
     *
     * The birthday is the day the **runner** selects at that instant, read from the runner
     * itself with the configured zone. So the cell ties D48's "today" to the selection's "today",
     * not to a second copy of the rule.
     */
    it.each([
      ['09:00 Bogotá, before either pass', '2026-09-14T14:00:00.000Z'],
      ['13:30 Bogotá, when UTC is past 14:00', '2026-09-14T18:30:00.000Z'],
      ['21:30 Bogotá, when UTC is already tomorrow', '2026-09-15T02:30:00.000Z'],
    ])('at %s, D48 and the runner agree on which day is today (%s)', async (_label, nowIso) => {
      const now = new Date(nowIso);
      const findDueUnprocessed = jest.fn().mockResolvedValue([]);
      const runner = new SchedulerRunner(
        { findDueUnprocessed } as unknown as SchedulerTaskRepository,
        { get: jest.fn() } as unknown as ExecuterFactory,
        { timeZone: env.TIME_ZONE, schedulerEnabled: true } as unknown as AppConfigService,
      );
      jest.spyOn(runner['logger'], 'log').mockImplementation(() => undefined);

      await runner.run(now);
      const selected = (findDueUnprocessed.mock.calls[0] as [PlainDate])[0];

      // ⚠️ **C90 (N1): the comparison that used to be here is gone.** It called
      // `nextBirthdayRunDate` with and without `env.TIME_ZONE` and expected the two to agree —
      // but `TIME_ZONE` is pinned by the env schema to the same constant the default uses, so
      // those are the same call and the cell could not fail. What ties D48 to the runner is
      // the today/next-year check below, which is the whole point of this cell.
      const birthdate = { year: 1990, month: selected.month, day: selected.day };

      // D48 treats the runner's "today" as today: before 14:00 it keeps it, after 14:00
      // it moves it to next year. Neither answer is a date the runner has already passed.
      const runDate = nextBirthdayRunDate(birthdate, now);
      const keptToday =
        runDate.year === selected.year &&
        runDate.month === selected.month &&
        runDate.day === selected.day;
      const movedToNextYear =
        runDate.year === selected.year + 1 &&
        runDate.month === selected.month &&
        runDate.day === selected.day;
      expect(keptToday || movedToNextYear).toBe(true);
    });
  });
});
