import { Client } from 'pg';

/**
 * Refuses to let the e2e suite touch a database that is **not** disposable — review
 * condition **C25**, finding **S6**.
 *
 * ## What this protects
 *
 * `resetDatabase` runs `TRUNCATE TABLE … RESTART IDENTITY CASCADE`, and `global-setup.ts`
 * runs `prisma migrate deploy`, both against `TEST_DATABASE_URL`. `setup-env.ts` correctly
 * pins `DATABASE_URL` to the test database, so the *documented* footgun is closed — but a
 * tester who has just been reading the deviations doc (which has them exporting two other
 * `fondodev` URLs in the same shell) and types `TEST_DATABASE_URL=…/fondodev` destroys the
 * **94-row notification fixture, the 15 users and the 632 scheduler rows**, irreversibly.
 * Against `fondodev` the `migrate deploy` is a no-op (the baseline is marked applied, never
 * executed) so nothing else would have stopped the `TRUNCATE`.
 *
 * That fixture is the one artefact in this project that cannot be regenerated: it is real
 * production data written by v1 over several years, and it is what every parity round's
 * hstore encoding evidence rests on.
 *
 * ## How it decides
 *
 * Two positive markers of "a database Django built and v1 uses", either of which is fatal:
 *
 * 1. **`django_migrations` has rows.** `fondodev` has 38; a database provisioned from the
 *    Prisma baseline has the table (it is mapped in `schema.prisma`) but **zero** rows,
 *    because v2 never writes Django's ledger.
 * 2. **`_prisma_migrations.0_init.applied_steps_count = 0`.** The plan's own baseline rule:
 *    on a database v1 created, `0_init` is *marked* applied and never executed. `migrate
 *    deploy` on a fresh test database executes it and records a non-zero step count.
 *
 * Plus a name denylist as a weaker second line, so an empty-but-shared database (a restored
 * dump before Django has run, say) is still refused.
 *
 * The check is positive-evidence-based on purpose: a check that only *allowed* known-good
 * names would have to be updated for every new CI database, and the failure mode of
 * forgetting is silent destruction rather than a red test.
 */
export class SharedDatabaseError extends Error {
  constructor(reason: string, databaseName: string) {
    super(
      `Refusing to run the e2e suite against "${databaseName}": ${reason}. ` +
        'TEST_DATABASE_URL must point at a disposable database — the e2e suite TRUNCATEs it. ' +
        'The shared dev database (fondodev) holds the irreplaceable parity fixture.',
    );
    this.name = 'SharedDatabaseError';
  }
}

/** Database names that are never disposable, whatever their contents say. */
const DENYLISTED_NAMES = new Set(['fondodev', 'fondo', 'fondoprod', 'fondo_api', 'postgres']);

/** URLs already cleared in this process; the check is a few queries, not free. */
const verified = new Set<string>();

export function databaseNameOf(databaseUrl: string): string {
  return new URL(databaseUrl).pathname.replace(/^\//, '');
}

/**
 * Throws {@link SharedDatabaseError} unless `databaseUrl` names a database the suite may
 * destroy. Safe to call repeatedly; the result is memoised per URL.
 *
 * A database that does not exist yet is fine — `provisionTestDatabase` is about to create it.
 */
export async function assertDisposableDatabase(databaseUrl: string): Promise<void> {
  if (verified.has(databaseUrl)) {
    return;
  }
  const databaseName = databaseNameOf(databaseUrl);

  if (DENYLISTED_NAMES.has(databaseName)) {
    throw new SharedDatabaseError('the name is on the shared-database denylist', databaseName);
  }

  const reason = await inspect(databaseUrl);
  if (reason !== null) {
    throw new SharedDatabaseError(reason, databaseName);
  }
  verified.add(databaseUrl);
}

/** @returns the reason this database must not be truncated, or `null` when it is safe. */
async function inspect(databaseUrl: string): Promise<string | null> {
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
  } catch {
    // Does not exist / not reachable yet. `provisionTestDatabase` handles creation, and a
    // genuinely unreachable database fails loudly a moment later on its own terms.
    return null;
  }

  try {
    const django = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM django_migrations WHERE to_regclass('public.django_migrations') IS NOT NULL",
    );
    if (Number(django.rows[0]?.count ?? '0') > 0) {
      return `django_migrations has ${django.rows[0]?.count} rows, so Django owns this schema`;
    }

    const baseline = await client.query<{ applied_steps_count: number }>(
      "SELECT applied_steps_count FROM _prisma_migrations WHERE migration_name = '0_init'",
    );
    if (baseline.rows.length > 0 && baseline.rows[0].applied_steps_count === 0) {
      return (
        'the Prisma baseline 0_init is marked applied with applied_steps_count = 0, ' +
        'which is how a database v1 created is baselined'
      );
    }
    return null;
  } catch (error) {
    // A missing table means this is not a Django database; anything else is worth surfacing.
    const message = error instanceof Error ? error.message : String(error);
    if (/does not exist/.test(message)) {
      return null;
    }
    throw error;
  } finally {
    await client.end();
  }
}
