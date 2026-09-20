import path from 'node:path';
import { BOGOTA_TIME_ZONE, todayInBogota } from '../common/utils/timezone.util';

/**
 * Which migration ledger a `prisma` invocation applies — and the two-variable confirmation
 * that guards the Phase 9 step-6 one-way door (review condition **C96**).
 *
 * ## The default
 *
 * `prisma/migrations` holds `0_init` and nothing else. That is what `test/test-database.ts`
 * applies to `fondo_api_test` and what `buildspec.yml` applies in CI. Phase 9 step 6's
 * migrations deliberately live **outside** it (`prisma/migrations-step6`): under operator
 * answer **Q56** production deploys run `prisma migrate deploy`, so a one-way conversion
 * sitting in the default path fires on the next routine deploy, unattended (**C92**).
 *
 * ## Why a warning was not enough — C96
 *
 * The first version only warned when the path was non-default. The residual the reviewer
 * named is real and specific: a `PRISMA_MIGRATIONS_PATH` left behind in a task definition or
 * a parameter store converts **production** on a routine deploy; and because Release A
 * carries the step-6 directory through cutover by design, that same build's
 * `SchemaShapeGuard` then refuses to start. The door fires, the service is down, and
 * rollback is dead — from a deploy nobody was watching.
 *
 * So a non-default ledger now needs a **second** variable, carrying **today's date in
 * Bogotá**:
 *
 * ```bash
 * PRISMA_MIGRATIONS_PATH=prisma/migrations-step6 STEP6_CONFIRM=$(TZ=America/Bogota date +%F) \
 *   npx prisma migrate deploy
 * ```
 *
 * Two properties, both deliberate:
 *
 *  * **A leftover goes stale within a day.** Whatever a forgotten `STEP6_CONFIRM` says, it
 *    stops matching at the next Bogotá midnight, so the failure mode is "a deploy errors
 *    tomorrow", not "a deploy converts production next month".
 *  * **The door needs two correct variables set on purpose**, one of which cannot be copied
 *    from yesterday's runbook without editing.
 *
 * The zone is Bogotá, not the host's, for the same reason everything else in this codebase
 * pins it (§4 rule 5): a `date +%F` typed on a UTC host between 19:00 and midnight Bogotá is
 * already tomorrow, and an operator reading "today" would be handed a confusing refusal.
 */

export const DEFAULT_MIGRATIONS_PATH = path.join('prisma', 'migrations');

/** The variable that carries the operator's dated confirmation. */
export const STEP6_CONFIRM_VAR = 'STEP6_CONFIRM';

/** The variable that selects a non-default ledger. */
export const MIGRATIONS_PATH_VAR = 'PRISMA_MIGRATIONS_PATH';

export class Step6ConfirmationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Step6ConfirmationError';
  }
}

export interface MigrationsPathResolution {
  /** The directory Prisma will read migrations from. */
  readonly path: string;
  /** One line for the log. Always present, so a leftover is visible even when it is valid. */
  readonly message: string;
  /** `warn` for a non-default ledger, `info` for the default. */
  readonly level: 'info' | 'warn';
}

/** `YYYY-MM-DD`, and nothing else — no `2026-9-1`, no trailing text, no whitespace. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function formatPlainDate(date: { year: number; month: number; day: number }): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.year}-${pad(date.month)}-${pad(date.day)}`;
}

/** Today in Bogotá as `YYYY-MM-DD`. Exported so the runbook's command can be checked. */
export function todayInBogotaIso(now: Date = new Date()): string {
  return formatPlainDate(todayInBogota(now));
}

/**
 * Resolves the ledger, throwing unless a non-default one is confirmed for **today**.
 *
 * Pure: no `console`, no `process.env` read, no clock read. The caller supplies both, which
 * is what lets the four failure shapes — missing, stale, malformed, and a future date — each
 * have a cell.
 */
export function resolveMigrationsPath(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  today: string,
): MigrationsPathResolution {
  const configured = env[MIGRATIONS_PATH_VAR];

  if (configured === undefined || configured === DEFAULT_MIGRATIONS_PATH) {
    return {
      path: DEFAULT_MIGRATIONS_PATH,
      message: `prisma migrations ledger: ${DEFAULT_MIGRATIONS_PATH}`,
      level: 'info',
    };
  }

  const confirmation = env[STEP6_CONFIRM_VAR];
  const how =
    `Set both, inline on the one command:\n` +
    `  ${MIGRATIONS_PATH_VAR}=${configured} ${STEP6_CONFIRM_VAR}=$(TZ=${BOGOTA_TIME_ZONE} date +%F) npx prisma migrate deploy\n` +
    `Never in a task definition, an .env file or a parameter store: under Q56 every deploy ` +
    `runs migrate deploy. See docs/phase-9-design.md §3.1 and §6.3.`;

  if (confirmation === undefined || confirmation === '') {
    throw new Step6ConfirmationError(
      `REFUSING: ${MIGRATIONS_PATH_VAR} is "${configured}", which is not the default ledger ` +
        `(${DEFAULT_MIGRATIONS_PATH}), and ${STEP6_CONFIRM_VAR} is not set.\n` +
        `That ledger holds the Phase 9 step-6 migrations — a ONE-WAY conversion of two hstore ` +
        `columns, after which rollback to v1 is dead.\n${how}`,
    );
  }

  if (!ISO_DATE.test(confirmation)) {
    throw new Step6ConfirmationError(
      `REFUSING: ${STEP6_CONFIRM_VAR}="${confirmation}" is not a YYYY-MM-DD date.\n` +
        `It must be today's date in ${BOGOTA_TIME_ZONE}, which is ${today}.\n${how}`,
    );
  }

  if (confirmation !== today) {
    throw new Step6ConfirmationError(
      `REFUSING: ${STEP6_CONFIRM_VAR}="${confirmation}" is not today in ${BOGOTA_TIME_ZONE} ` +
        `(${today}).\n` +
        `A confirmation left behind in a task definition or a parameter store goes stale at ` +
        `the next Bogotá midnight, which is the point: a forgotten variable must not convert ` +
        `production on a routine deploy.\n${how}`,
    );
  }

  return {
    path: configured,
    message:
      `WARNING: ${MIGRATIONS_PATH_VAR} is set to "${configured}" and confirmed for ${today}. ` +
      `This is NOT the default ledger (${DEFAULT_MIGRATIONS_PATH}); it holds the Phase 9 ` +
      `step-6 migrations, a ONE-WAY conversion. If you did not mean to run them, stop now.`,
    level: 'warn',
  };
}
