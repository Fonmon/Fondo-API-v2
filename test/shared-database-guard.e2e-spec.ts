import { Client } from 'pg';
import {
  assertDisposableDatabase,
  databaseNameOf,
  SharedDatabaseError,
} from './shared-database-guard';
import { TEST_DATABASE_URL } from './test-database';

/**
 * Condition **C25** / review finding **S6** — `resetDatabase` was one environment variable
 * away from truncating the irreplaceable parity fixture.
 *
 * Every cell here is a *negative* one: it proves the suite refuses to run rather than that it
 * runs. That is the only kind of evidence worth having for a destructive operation.
 */
describe('C25 — shared-database guard', () => {
  it('refuses the shared dev database by name, without needing to connect', async () => {
    await expect(
      assertDisposableDatabase(
        // ⚠️ **Load-bearing, not a stray credential (review N11).** This cell exists to prove
        // that *this exact URL* is refused; a placeholder would leave the guard untested
        // against the one string it is written to stop.
        'postgresql://fondouser:fondo@localhost:5432/fondodev?schema=public',
      ),
    ).rejects.toBeInstanceOf(SharedDatabaseError);
  });

  it('refuses every denylisted name, including an unreachable host', async () => {
    for (const name of ['fondodev', 'fondo', 'fondoprod', 'fondo_api', 'postgres']) {
      await expect(
        assertDisposableDatabase(`postgresql://u:p@nonexistent.invalid:5432/${name}`),
      ).rejects.toThrow(/denylist/);
    }
  });

  it('allows the disposable e2e database', async () => {
    await expect(assertDisposableDatabase(TEST_DATABASE_URL)).resolves.toBeUndefined();
  });

  it('refuses a database whose django_migrations ledger has rows', async () => {
    // A distinct URL string for the same database, because the guard memoises per URL.
    const probeUrl = `${TEST_DATABASE_URL}&c25=django`;
    const client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      await client.query(
        "INSERT INTO django_migrations (app, name, applied) VALUES ('c25', 'probe', now())",
      );
      await expect(assertDisposableDatabase(probeUrl)).rejects.toThrow(
        /django_migrations has 1 rows/,
      );
    } finally {
      await client.query("DELETE FROM django_migrations WHERE app = 'c25'");
      await client.end();
    }
  });

  it('refuses a database whose Prisma baseline is marked applied but never executed', async () => {
    const probeUrl = `${TEST_DATABASE_URL}&c25=baseline`;
    const client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    let previous: number | undefined;
    try {
      const before = await client.query<{ applied_steps_count: number }>(
        "SELECT applied_steps_count FROM _prisma_migrations WHERE migration_name = '0_init'",
      );
      previous = before.rows[0]?.applied_steps_count;
      await client.query(
        "UPDATE _prisma_migrations SET applied_steps_count = 0 WHERE migration_name = '0_init'",
      );
      await expect(assertDisposableDatabase(probeUrl)).rejects.toThrow(/applied_steps_count = 0/);
    } finally {
      if (previous !== undefined) {
        await client.query(
          "UPDATE _prisma_migrations SET applied_steps_count = $1 WHERE migration_name = '0_init'",
          [previous],
        );
      }
      await client.end();
    }
  });

  it('reads the database name out of the URL', () => {
    expect(databaseNameOf('postgresql://u:p@h:5432/fondodev?schema=public')).toBe('fondodev');
    expect(databaseNameOf('postgresql://u:p@h:5432/fondo_api_test')).toBe('fondo_api_test');
  });
});
