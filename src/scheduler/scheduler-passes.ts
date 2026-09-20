/**
 * **Phase 8b / D48.** The Bogotá hours at which the scheduler runs a pass.
 *
 * `crontab(minute=0, hour='10,14')` (`api/celery.py:13`), transcribed in
 * `scheduler.runner.ts` as `SCHEDULER_CRON_EXPRESSION`. The expression stays a literal there,
 * so its own cells keep asserting v1's text. This table exists for the one consumer that has to
 * reason *about* the passes: `nextBirthdayRunDate` in `user.service.ts`, which asks whether a
 * pass is still to run today.
 *
 * ⚠️ **The two must not drift.** `scheduler.runner.spec.ts` checks that the cron's hour field is
 * exactly this list and its minute field is `0`. If a pass moves, that cell fails before D48
 * silently keeps the old boundary.
 */
export const SCHEDULER_PASS_HOURS: readonly number[] = [10, 14];

/** The day's last pass, `14` today. A birthday task written at or after it goes to next year. */
export const LAST_SCHEDULER_PASS_HOUR: number =
  SCHEDULER_PASS_HOURS[SCHEDULER_PASS_HOURS.length - 1];
