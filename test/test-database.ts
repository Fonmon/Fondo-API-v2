import { execFileSync } from 'node:child_process';
import { Client } from 'pg';
import { assertDisposableDatabase } from './shared-database-guard';

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
/**
 * The ledger Release A provisions with: the Prisma baseline and nothing else.
 * `prisma/migrations-step6` is deliberately not here — see the note in
 * `provisionTestDatabase` and `docs/phase-9-design.md` §3.1.
 */
export const RELEASE_A_MIGRATIONS_PATH = 'prisma/migrations';

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
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      databaseName,
    ]);
    if (existing.rowCount === 0) {
      // Identifier, not a value - cannot be parameterised.
      await admin.query(`CREATE DATABASE "${databaseName.replace(/"/g, '""')}"`);
    }
  } finally {
    await admin.end();
  }

  // ⚠️ `PRISMA_MIGRATIONS_PATH` is pinned, not inherited — review finding **m3**. A developer
  // with the Phase 9 step-6 path exported in their shell would otherwise have the e2e suite
  // convert `fondo_api_test` to jsonb on its next run, and Release A cannot read jsonb
  // (measured: 25 of 38 cells fail in two suites). The ambient value must not reach here.
  //
  // ⚠️ **Stage 2a note (conditions C92, C94).** The step-6 directory stays outside
  // `prisma/migrations` — through Release B and past cutover — because moving it would put
  // the one-way door back into the ledger every production deploy applies (Q56).
  //
  // So when **Release B's code lands (stage 2a)**, this provisioner needs **two sequential
  // `migrate deploy` runs** — `prisma/migrations`, then `prisma/migrations-step6` — added in
  // **the same commit** as the hstore codec's deletion. Not before: until that commit the
  // suites are Release A's, they read hstore, and a second run here converts `fondo_api_test`
  // and stops them passing.
  //
  // ⚠️ Getting the stage wrong here is not cosmetic — it is **C94**. A developer who starts
  // stage 2a and finds every e2e suite dying at bootstrap on `SchemaShapeError` has one
  // obvious-looking way out — `git mv prisma/migrations-step6/* prisma/migrations/` — and that
  // is precisely the move C92 exists to prevent. The fix is the second run below, not the move.
  //
  // **Stage 2b** — after step 6 has run in production — is the directory move and deleting
  // `PRISMA_MIGRATIONS_PATH`, and nothing else.
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: {
      ...process.env,
      DATABASE_URL: TEST_DATABASE_URL,
      PRISMA_MIGRATIONS_PATH: RELEASE_A_MIGRATIONS_PATH,
    },
    stdio: 'inherit',
  });
}
