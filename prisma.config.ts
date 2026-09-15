import path from 'node:path';
import { config as loadDotEnv } from 'dotenv';
import { defineConfig, env } from 'prisma/config';

// Prisma 7 no longer loads `.env` implicitly.
loadDotEnv();

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    // Default: the Release-A ledger — `0_init` and nothing else, which is what
    // `test/test-database.ts` applies to `fondo_api_test` and what CI applies in
    // `buildspec.yml`. Phase 9 step 6's migrations deliberately live OUTSIDE it
    // (`prisma/migrations-step6`), because a one-way door in the default path is one
    // `migrate deploy` away from firing. The step-6 runbook sets this variable for exactly
    // one command; stage 2 folds the directory back in and deletes the knob.
    path: process.env.PRISMA_MIGRATIONS_PATH ?? path.join('prisma', 'migrations'),
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
