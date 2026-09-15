import path from 'node:path';
import { config as loadDotEnv } from 'dotenv';
import { defineConfig, env } from 'prisma/config';
import {
  resolveMigrationsPath,
  Step6ConfirmationError,
  todayInBogotaIso,
} from './src/config/step6-migrations-path';

// Prisma 7 no longer loads `.env` implicitly.
loadDotEnv();

/**
 * The ledger this invocation applies, and the two-variable gate on the step-6 one-way door.
 *
 * All of the decision lives in `src/config/step6-migrations-path.ts` as a pure function, so
 * every refusal shape — missing, stale, malformed, correct — has a unit cell. This file only
 * supplies `process.env` and the clock, and prints the result.
 */
function migrationsPath(): string {
  try {
    const resolution = resolveMigrationsPath(process.env, todayInBogotaIso());
    if (resolution.level === 'warn') {
      console.warn(resolution.message);
    } else {
      console.info(resolution.message);
    }
    return resolution.path;
  } catch (error) {
    if (error instanceof Step6ConfirmationError) {
      // One readable paragraph, not a stack trace: this is read by an operator mid-cutover.
      console.error(`\n${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: migrationsPath(),
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
