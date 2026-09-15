import path from 'node:path';
import { config as loadDotEnv } from 'dotenv';
import { defineConfig, env } from 'prisma/config';

// Prisma 7 no longer loads `.env` implicitly.
loadDotEnv();

const DEFAULT_MIGRATIONS_PATH = path.join('prisma', 'migrations');

/**
 * Which migration ledger this invocation will apply.
 *
 * Default: the Release-A ledger — `0_init` and nothing else, which is what
 * `test/test-database.ts` applies to `fondo_api_test` and what `buildspec.yml` applies in CI.
 * **Phase 9 step 6's migrations deliberately live OUTSIDE it** (`prisma/migrations-step6`):
 * under operator answer **Q56** production deploys run `prisma migrate deploy`, so a one-way
 * door sitting in the default path is one routine deploy away from firing unattended
 * (condition **C92**). The step-6 runbook sets this variable **inline on that one command**
 * and nowhere else — never in a task definition, an `.env` file or a parameter store.
 *
 * ⚠️ The resolved path is printed on **every** invocation, and a non-default value is printed
 * as a WARNING, so a leftover variable is visible in a deploy log rather than inferable from
 * which migrations ran. (Review finding B3 asked for a warning whenever the variable is set;
 * `test-database.ts` now pins it to the default deliberately — m3 — so warning on "set"
 * alone would fire on every e2e run and train people to ignore it. Warning on "not the
 * default" is the dangerous case; the always-printed line covers the rest.)
 */
function resolveMigrationsPath(): string {
  const configured = process.env.PRISMA_MIGRATIONS_PATH;
  const resolved = configured ?? DEFAULT_MIGRATIONS_PATH;
  if (resolved !== DEFAULT_MIGRATIONS_PATH) {
    console.warn(
      `WARNING: PRISMA_MIGRATIONS_PATH is set to "${resolved}". This is NOT the default ` +
        `ledger (${DEFAULT_MIGRATIONS_PATH}). If you did not mean to run the Phase 9 step-6 ` +
        'migrations — which are a ONE-WAY conversion of two hstore columns — stop now and ' +
        'unset it. See docs/phase-9-design.md §6.',
    );
  } else {
    console.info(`prisma migrations ledger: ${resolved}`);
  }
  return resolved;
}

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: resolveMigrationsPath(),
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
