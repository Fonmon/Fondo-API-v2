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

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'inherit',
  });
}
