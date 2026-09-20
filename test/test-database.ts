import { execFileSync } from 'node:child_process';
import { Client } from 'pg';
import { assertDisposableDatabase } from './shared-database-guard';
import { todayInBogotaIso } from '../src/config/step6-migrations-path';

/**
 * The e2e suite never touches the shared dev database. It provisions its own from the
 * Prisma baseline (`prisma/migrations/0_init`), which is also the only place that migration
 * is ever executed — on every database v1 created it is merely marked applied.
 *
 * Override with `TEST_DATABASE_URL`; CI points it at the throwaway Postgres container.
 *
 * ⚠️ **Whatever it is set to must survive `assertDisposableDatabase`** (condition **C25**).
 * Everything in here TRUNCATEs, and the shared `fondodev` holds the irreplaceable parity
 * fixture.
 */
/** The Prisma baseline — the schema Django created, and nothing else. */
export const BASELINE_MIGRATIONS_PATH = 'prisma/migrations';

/**
 * Phase 9 step 6. **Deliberately a second directory, not folded into the baseline** — under
 * operator answer **Q56** production deploys run `migrate deploy`, so a one-way conversion in
 * the default ledger fires on the next routine deploy (**C92**). It moves in only in stage 2b,
 * after step 6 has run in production.
 */
export const STEP6_MIGRATIONS_PATH = 'prisma/migrations-step6';

// ⚠️ **The literal is the documented local fallback, not a stray credential (review N11).**
// It names `fondo_api_test`, which `assertDisposableDatabase` re-checks before anything
// destructive; README and `docs/SESSION-STATE.md` §3 both quote it, and `buildspec.yml` uses
// the CI equivalent. Replacing it with a placeholder would break `npm run test:e2e` on a fresh
// checkout for no gain — the value is a local development password.
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://fondouser:fondo@localhost:5432/fondo_api_test?schema=public';

function maintenanceUrl(databaseUrl: string): { adminUrl: string; databaseName: string } {
  const url = new URL(databaseUrl);
  const databaseName = url.pathname.replace(/^\//, '');
  url.pathname = '/postgres';
  url.search = '';
  return { adminUrl: url.toString(), databaseName };
}

/**
 * Creates the test database if it does not exist, then applies the Prisma baseline.
 *
 * Condition **C25**: the target is proven disposable *before* either destructive step —
 * `CREATE DATABASE` is harmless, but `prisma migrate deploy` and every subsequent
 * `resetDatabase` are not.
 */
export async function provisionTestDatabase(): Promise<void> {
  await assertDisposableDatabase(TEST_DATABASE_URL);

  const { adminUrl, databaseName } = maintenanceUrl(TEST_DATABASE_URL);

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName.replace(/"/g, '""')}"`);
    await admin.query(`CREATE DATABASE "${databaseName.replace(/"/g, '""')}"`);
  } finally {
    await admin.end();
  }

  // ⚠️ `PRISMA_MIGRATIONS_PATH` is pinned on each run, not inherited — review finding **m3**.
  // The ambient value must not decide which ledgers a test database gets.
  //
  // 🔴 **The two builds cannot share this database — measured, 2026-09-15.** Gating the
  // `release-a-cutover` tag against a `fondo_api_test` that still held head's **converted**
  // schema failed **1306 of 1388** e2e cells: Release A's `SchemaShapeGuard` refused to start
  // and named both columns. That is the guard doing its job, not a defect — but the symptom
  // is a wall of bootstrap errors rather than an assertion, so it does not read as "wrong
  // schema" at first glance.
  //
  //     dropdb fondo_api_test && npm run test:e2e     # the provisioner rebuilds it
  //
  // Whichever checkout ran last leaves a database the other cannot boot on: Release A builds
  // it from `prisma/migrations` alone (hstore), head builds it from both ledgers (jsonb). And
  // because the counts are nearly identical either way — 1386 on hstore, 1387 on jsonb — the
  // number alone does not say which shape a run was on. Say it when reporting one.
  //
  // ⚠️ **Two sequential deploys, not one, and not a moved directory (C92, C94).** This is
  // Release B's code: the hstore codec is gone and `SchemaShapeGuard` requires `jsonb`, so a
  // test database built from the baseline alone makes **every** e2e suite die at bootstrap on
  // `SchemaShapeError`. The fix is the second run below. The tempting alternative —
  // `git mv prisma/migrations-step6/* prisma/migrations/` — re-arms the one-way door in the
  // ledger every production deploy applies, which is the thing C92 exists to prevent.
  //
  // **Stage 2b** — after step 6 has run in production — is that move, plus deleting
  // `PRISMA_MIGRATIONS_PATH`, and nothing else.
  const deploy = (migrationsPath: string, confirm?: string): void => {
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      env: {
        ...process.env,
        DATABASE_URL: TEST_DATABASE_URL,
        PRISMA_MIGRATIONS_PATH: migrationsPath,
        ...(confirm === undefined ? {} : { STEP6_CONFIRM: confirm }),
      },
      stdio: 'inherit',
    });
  };

  deploy(BASELINE_MIGRATIONS_PATH);
  // ⚠️ **The second run is what makes the e2e database Release B's** (C94). `STEP6_CONFIRM`
  // is C96's gate: a non-default ledger is refused unless a variable carries today's date in
  // Bogotá. It is computed here rather than written down, so this provisioner keeps working
  // tomorrow and can never be the thing that leaves a stale confirmation behind.
  deploy(STEP6_MIGRATIONS_PATH, todayInBogotaIso());
}
