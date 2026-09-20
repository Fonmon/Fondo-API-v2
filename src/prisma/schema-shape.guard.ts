import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Refuses to boot against the wrong side of the Phase 9 step-6 one-way door.
 *
 * ## Why this exists (operator answer **Q57**, review finding **M7**, condition **C93**)
 *
 * Step 6 converts `fondo_api_schedulertask.payload` and
 * `fondo_api_notificationsubscriptions.subscription` from `hstore` to `jsonb`. The two builds
 * either side of it cannot run on each other's schema, and — measured on a migrated clone,
 * 2026-09-15 — the failure is **per request**, not at boot:
 *
 *   * Release A writing into a converted column:
 *     `ERROR: column "payload" is of type jsonb but expression is of type hstore`;
 *   * Release A reading one: `SELECT payload::text` returns JSON, which `parseHstore` throws
 *     on — the codec is deleted now, but that was the measurement);
 *   * Release B against an un-migrated column: the mirror image.
 *
 * Without this guard, a build deployed on the wrong side **starts cleanly**, serves every
 * other route, and fails only on notifications and on the scheduler — one of which runs
 * unattended twice a day and is the fund's only payment-reminder path. The operator chose the
 * guard in both directions (Q57); this file is the Release A half.
 *
 * ## Why throwing here is safe, and what it actually stops
 *
 * `onModuleInit` runs inside `app.init()`, which `app.listen()` awaits, and `main.ts`'s
 * `bootstrap().catch(...)` writes the message and `process.exit(1)`. Nest never reaches the
 * bootstrap phase, so:
 *
 *   * `SchedulerOrchestrator.onApplicationBootstrap` — which is what **starts** the cron jobs
 *     `ScheduleExplorer.onModuleInit` registered — never runs, so no pass fires;
 *   * `GunicornHttpEdge.onApplicationBootstrap` never runs, so the HTTP edge is never wired;
 *   * `app.listen()` is never reached, so no port is opened.
 *
 * ⚠️ **Scope, stated honestly:** this bites on the **next boot**, not on a running process.
 * Between the conversion and the Release B rollout, a live Release A keeps serving and keeps
 * erroring on those two subsystems. The guard converts a *wrong-order deploy or restart* into
 * a refusal to start; it does not shorten the window that the runbook's quiesce step closes.
 */

/** One row of the shape probe. */
export interface SchemaColumnShape {
  readonly table_name: string;
  readonly udt_name: string;
}

/** The two columns step 6 converts, and the build that is allowed to see each type. */
export const STEP6_COLUMNS = [
  { table: 'fondo_api_notificationsubscriptions', column: 'subscription' },
  { table: 'fondo_api_schedulertask', column: 'payload' },
] as const;

/**
 * The type **this build** requires.
 *
 * 🔴 **Flipped to `jsonb` by stage 2a — this is Release B.** The hstore codec is deleted, both
 * repositories are on Prisma models and `schema.prisma` declares `Json @db.JsonB`, so this
 * build cannot read an un-migrated database: `subscription` would arrive as an hstore value
 * Prisma cannot map, and every notification and scheduler pass would fail per request.
 *
 * It is a constant rather than configuration on purpose: which side of the door a build
 * belongs on is a property of its code, not of its environment, and an env var here would let
 * a deployment silently opt out of the check.
 *
 * ⚠️ The Release A image — the one cutover step 3 deploys — carries this same file with
 * `'hstore'` here, and refuses to start on a converted database. That is operator answer
 * **Q57**: the guard bites in both directions.
 */
export const REQUIRED_COLUMN_TYPE = 'jsonb';

export class SchemaShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaShapeError';
  }
}

/**
 * The whole decision, as a pure function, so every wrong shape has a unit cell.
 *
 * ⚠️ It requires **exactly the two expected rows, each of the required type**. The obvious
 * `rows.every(r => r.udt_name === required)` passes vacuously on an empty result — which is
 * what a typo in the probe, a different `search_path`, or a renamed table all produce — and
 * that is the one failure mode a boot guard must not have.
 */
export function assertSchemaShape(rows: readonly SchemaColumnShape[], required: string): void {
  const expected = STEP6_COLUMNS.map((c) => c.table)
    .slice()
    .sort();
  const found = rows
    .map((r) => r.table_name)
    .slice()
    .sort();

  const sameSet =
    found.length === expected.length && expected.every((name, index) => found[index] === name);

  if (!sameSet) {
    throw new SchemaShapeError(
      `Refusing to start: expected to find exactly the two step-6 columns ` +
        `(${expected.join(', ')}) in the current schema, found ${rows.length === 0 ? 'none' : found.join(', ')}. ` +
        'Either this is not the Fondo database, or the connection resolved a different schema. ' +
        'See docs/phase-9-design.md §6.',
    );
  }

  const wrong = rows.filter((r) => r.udt_name !== required);
  if (wrong.length > 0) {
    const detail = rows.map((r) => `${r.table_name}=${r.udt_name}`).join(', ');
    throw new SchemaShapeError(
      `Refusing to start: this build requires the step-6 columns to be "${required}", found ${detail}. ` +
        (required === 'hstore'
          ? 'This database has already had the Phase 9 step-6 migration applied; deploy Release B instead. ' +
            'Rolling back to this build is not a recovery path — the conversion is one-way.'
          : 'This database has NOT had the Phase 9 step-6 migration applied; run it before deploying this build. ' +
            'See docs/phase-9-design.md §6.3.'),
    );
  }
}

/**
 * The probe, with the schema as a SQL *expression* so that the same text can be aimed at
 * `current_schema()` in production and at a scratch schema from a test. One source, so the
 * cell that runs it against a genuinely converted schema is running the shipped query.
 *
 * `schemaExpression` is never user input — it is one of two literals in this repository.
 */
export function schemaShapeSql(schemaExpression: string): string {
  return `
    SELECT table_name::text AS table_name, udt_name::text AS udt_name
      FROM information_schema.columns
     WHERE table_schema = ${schemaExpression}
       AND ((table_name = 'fondo_api_schedulertask' AND column_name = 'payload')
         OR (table_name = 'fondo_api_notificationsubscriptions' AND column_name = 'subscription'))
     ORDER BY table_name`;
}

@Injectable()
export class SchemaShapeGuard implements OnModuleInit {
  private readonly logger = new Logger(SchemaShapeGuard.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    const rows = await this.prisma.$queryRawUnsafe<SchemaColumnShape[]>(
      schemaShapeSql('current_schema()'),
    );

    assertSchemaShape(rows, REQUIRED_COLUMN_TYPE);
    this.logger.log(
      `Schema shape OK: both step-6 columns are "${REQUIRED_COLUMN_TYPE}" (post-step-6 build)`,
    );
  }
}
