import { provisionTestDatabase } from './test-database';

/**
 * ⚠️ Same pin, same reason, as `jest.config.ts`: the e2e host zone is deliberately **not**
 * `America/Bogota`, so that any code reading a calendar date from the host instead of from
 * `timezone.util.ts` produces a wrong date here rather than a coincidentally right one on a
 * −05:00 laptop (review C28).
 *
 * It has to be here and not in `setup-env.ts`: `setupFiles` run inside jest's vm context,
 * where assigning `process.env.TZ` does not reach V8's cached zone. `globalSetup` runs in the
 * jest parent process, before the run and before any worker is forked.
 */
process.env.TZ = 'UTC';

export default async function globalSetup(): Promise<void> {
  await provisionTestDatabase();
}
