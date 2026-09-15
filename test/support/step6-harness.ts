import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { parseHstore, repairPythonReprToJson, type HstoreMap } from './hstore-legacy';

/**
 * Harness for the Phase 9 step-6 migration (`prisma/migrations-step6`).
 *
 * The migrations run against an isolated schema (`step6_mut`) inside the e2e test database,
 * built to the shape of the five tables they touch, so a mutation run neither depends on nor
 * disturbs `public` — which the rest of the e2e suite TRUNCATEs.
 *
 * ⚠️ The migration SQL is **read from the migration files**, never retyped. A mutation suite
 * that scores a copy of the SQL proves nothing about the file the operator will deploy.
 */

export const STEP6_SCHEMA = 'step6_mut';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'prisma', 'migrations-step6');

export const STEP6_MIGRATIONS = {
  preflight: '20260915120000_step6_preflight',
  convert: '20260915120100_hstore_to_jsonb',
  loanDetailUnique: '20260915120200_loandetail_unique_loan_id',
  userUnique: '20260915120300_userfinance_userpreference_unique_user_id',
} as const;

export function readMigration(name: string): string {
  return readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8');
}

/** The post-condition block the conversion migration carries, delimited in the file. */
const POST_CONDITION_OPEN = '-- >>> step6 post-conditions';
const POST_CONDITION_CLOSE = '-- <<< step6 post-conditions';

/**
 * Removes the conversion migration's own assertion block.
 *
 * Every mutant is scored twice: once against the shipped migration (where the in-transaction
 * assertions are expected to abort it) and once with them stripped, so that the *external*
 * equality check is what has to notice. Without this, a green mutation table would only
 * prove the migration guards itself, saying nothing about the checker.
 */
export function withoutPostConditions(sql: string): string {
  const open = sql.indexOf(POST_CONDITION_OPEN);
  const close = sql.indexOf(POST_CONDITION_CLOSE);
  if (open < 0 || close < 0) {
    throw new Error(
      'step6 harness: the post-condition markers are missing from the conversion migration. ' +
        'They are load-bearing for the mutation suite; re-add them rather than deleting this check.',
    );
  }
  return sql.slice(0, open) + sql.slice(close + POST_CONDITION_CLOSE.length);
}

/** A textual mutation of the migration, with the anchor it needs in order to bite. */
export interface Mutant {
  readonly id: string;
  readonly what: string;
  readonly from: string;
  readonly to: string;
  /** `kill` — the equality check must reject it. `survive` — a blind control. */
  readonly expected: 'kill' | 'survive';
}

/**
 * Applies a mutation, and **fails loudly if the anchor is missing or the text is unchanged**.
 *
 * A mutant whose substitution silently no-ops is indistinguishable from a blind control that
 * survives: it is the mutation-testing equivalent of a grep that cannot fire.
 */
export function applyMutant(sql: string, mutant: Mutant): string {
  if (!sql.includes(mutant.from)) {
    throw new Error(`step6 mutant "${mutant.id}": anchor not found in the migration SQL`);
  }
  const mutated = sql.replace(mutant.from, mutant.to);
  if (mutated === sql) {
    throw new Error(`step6 mutant "${mutant.id}": substitution changed nothing`);
  }
  return mutated;
}

// ---------------------------------------------------------------------------
// The scratch schema
// ---------------------------------------------------------------------------

/**
 * The five tables the step-6 migrations touch, in their `fondodev` shape (measured
 * 2026-09-15): both hstore columns `NOT NULL`, both id columns `integer`.
 */
const CREATE_TABLES = `
CREATE TABLE fondo_api_schedulertask (
  id        serial PRIMARY KEY,
  type      integer NOT NULL,
  run_date  timestamptz NOT NULL,
  payload   hstore NOT NULL,
  processed boolean NOT NULL,
  repeat    integer NOT NULL
);
CREATE TABLE fondo_api_notificationsubscriptions (
  id           serial PRIMARY KEY,
  user_id      integer NOT NULL,
  subscription hstore NOT NULL
);
CREATE TABLE fondo_api_loandetail (
  id      serial PRIMARY KEY,
  loan_id integer NOT NULL
);
CREATE TABLE fondo_api_userfinance (
  id      serial PRIMARY KEY,
  user_id integer NOT NULL
);
CREATE TABLE fondo_api_userpreference (
  id      serial PRIMARY KEY,
  user_id integer NOT NULL
);
`;

export async function createStep6Schema(client: Client): Promise<void> {
  await client.query(`DROP SCHEMA IF EXISTS ${STEP6_SCHEMA} CASCADE`);
  await client.query(`CREATE SCHEMA ${STEP6_SCHEMA}`);
  // `public` stays on the path for the hstore extension's operators and functions.
  await client.query(`SET search_path = ${STEP6_SCHEMA}, public`);
  await client.query(CREATE_TABLES);
}

export async function dropStep6Schema(client: Client): Promise<void> {
  await client.query(`DROP SCHEMA IF EXISTS ${STEP6_SCHEMA} CASCADE`);
}

// ---------------------------------------------------------------------------
// The equality check — v1's read semantics vs what the migration stored
// ---------------------------------------------------------------------------

/** One decoded entry: the value v1 would hand to the application for `table#id.key`. */
export interface DecodedEntry {
  readonly table: string;
  readonly id: number;
  readonly key: string;
  /** Canonical JSON text, so two representations compare as strings. */
  readonly value: string;
}

export interface Snapshot {
  readonly entries: readonly DecodedEntry[];
  readonly rows: readonly string[];
  /** The key order the column emits, per row — part of the SQS wire format (plan §2). */
  readonly keyOrder: readonly string[];
}

const HSTORE_TABLES: ReadonlyArray<{ table: string; column: string; repaired: string }> = [
  { table: 'fondo_api_schedulertask', column: 'payload', repaired: 'user_ids' },
  { table: 'fondo_api_notificationsubscriptions', column: 'subscription', repaired: 'keys' },
];

/**
 * v1's read semantics for one hstore entry, reusing the shipped codec for the two parts that
 * are not obvious — `parseHstore` and the `'` -> `"` repair — rather than restating them.
 *
 *   - `payload['user_ids']`  -> `json.loads(value)`
 *   - `subscription['keys']` -> `json.loads(value.replace("'", '"'))`
 *   - everything else        -> the string hstore stored; SQL NULL -> JSON null
 */
function decodeEntry(repairedKey: string, key: string, value: string | null): unknown {
  if (value === null) return null;
  if (key !== repairedKey) return value;
  return JSON.parse(repairedKey === 'keys' ? repairPythonReprToJson(value) : value) as unknown;
}

/** Canonical JSON text: object keys sorted, so ordering is compared separately and on purpose. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`)
    .join(',')}}`;
}

/**
 * ⚠️ **`Object.keys` hoists integer-like keys — review m8.** Both `snapshotHstore` and
 * `snapshotJsonb` read member order from `Object.keys`, and JavaScript objects enumerate
 * array-index-like keys ("0", "7", "42") first, in numeric order, ahead of every string key
 * whatever the insertion order. So a payload key that is a decimal integer string would be
 * reported in an order neither hstore nor jsonb emits, and the `keyOrder` comparison could
 * pass or fail for that reason alone.
 *
 * It does not bite here, and that is a measurement rather than an assumption: every key in
 * both columns on `fondodev` 2026-09-15 is alphabetic (`message, owner_id, target, type,
 * user_ids`; `endpoint, expirationTime, keys`), and the corpus adds only `code`, `flag`,
 * `amount` and `extra`. If a numeric key ever appears, this pair of functions must switch to
 * a `Map` or to reading the order from SQL (`each()` / `jsonb_object_keys()`, which
 * `step6-prove.sh` already does — and which is why the shell proof is the authority on key
 * order and this harness is the authority on values).
 */

/** Reads the hstore side and decodes it the way v1 does. */
export async function snapshotHstore(client: Client): Promise<Snapshot> {
  const entries: DecodedEntry[] = [];
  const rows: string[] = [];
  const keyOrder: string[] = [];

  for (const { table, column, repaired } of HSTORE_TABLES) {
    const result = await client.query<{ id: number; raw: string }>(
      `SELECT id, ${column}::text AS raw FROM ${table} ORDER BY id`,
    );
    for (const row of result.rows) {
      rows.push(`${table}#${row.id}`);
      const map: HstoreMap = parseHstore(row.raw);
      keyOrder.push(`${table}#${row.id}:${Object.keys(map).join(',')}`);
      for (const [key, value] of Object.entries(map)) {
        entries.push({
          table,
          id: row.id,
          key,
          value: canonical(decodeEntry(repaired, key, value)),
        });
      }
    }
  }
  return { entries, rows, keyOrder };
}

/** Reads the jsonb side, after the migration. */
export async function snapshotJsonb(client: Client): Promise<Snapshot> {
  const entries: DecodedEntry[] = [];
  const rows: string[] = [];
  const keyOrder: string[] = [];

  for (const { table, column } of HSTORE_TABLES) {
    const result = await client.query<{ id: number; doc: Record<string, unknown> }>(
      `SELECT id, ${column} AS doc FROM ${table} ORDER BY id`,
    );
    for (const row of result.rows) {
      rows.push(`${table}#${row.id}`);
      keyOrder.push(`${table}#${row.id}:${Object.keys(row.doc).join(',')}`);
      for (const [key, value] of Object.entries(row.doc)) {
        entries.push({ table, id: row.id, key, value: canonical(value) });
      }
    }
  }
  return { entries, rows, keyOrder };
}

export interface EqualityResult {
  readonly equal: boolean;
  readonly differences: readonly string[];
}

/**
 * Row-by-row, key-by-key semantic equality, plus row identity and emitted key order.
 *
 * The row-identity half is not decoration: a key-wise comparison alone **cannot** see an
 * empty-hstore row disappear, because such a row contributes no entries to either side.
 */
export function assertSemanticEquality(before: Snapshot, after: Snapshot): EqualityResult {
  const differences: string[] = [];

  const beforeRows = new Set(before.rows);
  const afterRows = new Set(after.rows);
  for (const row of beforeRows) {
    if (!afterRows.has(row)) differences.push(`row lost: ${row}`);
  }
  for (const row of afterRows) {
    if (!beforeRows.has(row)) differences.push(`row appeared: ${row}`);
  }
  if (before.rows.length !== after.rows.length) {
    differences.push(`row count ${before.rows.length} -> ${after.rows.length}`);
  }

  const key = (e: DecodedEntry): string => `${e.table}#${e.id}.${e.key}`;
  const beforeEntries = new Map(before.entries.map((e) => [key(e), e.value]));
  const afterEntries = new Map(after.entries.map((e) => [key(e), e.value]));

  for (const [k, value] of beforeEntries) {
    const other = afterEntries.get(k);
    if (other === undefined) {
      differences.push(`entry lost: ${k} (was ${value})`);
    } else if (other !== value) {
      differences.push(`entry changed: ${k}: ${value} -> ${other}`);
    }
  }
  for (const [k, value] of afterEntries) {
    if (!beforeEntries.has(k)) differences.push(`entry appeared: ${k} = ${value}`);
  }

  const beforeOrder = new Map(before.keyOrder.map((o) => [o.split(':')[0], o]));
  for (const order of after.keyOrder) {
    const rowKey = order.split(':')[0];
    const was = beforeOrder.get(rowKey);
    if (was !== undefined && was !== order) {
      differences.push(`key order changed: ${was} -> ${order}`);
    }
  }

  return { equal: differences.length === 0, differences };
}
