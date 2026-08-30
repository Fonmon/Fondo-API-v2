import { z } from 'zod';

/**
 * Runtime environment names. Mirrors v1's `api.settings.{development,test,production}`
 * split — `ENVIRONMENT` drives, among other things, whether the GCS client is anonymous
 * (`fondo_api/services/file.py`).
 */
export const ENVIRONMENTS = ['development', 'test', 'production'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

const nonEmpty = (name: string): z.ZodString =>
  z
    .string({ error: `${name} is required` })
    .trim()
    .min(1, `${name} must not be empty`);

/**
 * The v2 replacement for v1's scattered `os.environ` reads.
 *
 * v1 fails at *import* time with a bare `KeyError` when `DEFAULT_FROM_EMAIL` or
 * `AWS_REGION` is missing (`fondo_api/services/mail.py`, `fondo_api/celery/tasks.py`) and
 * silently renders the string `None` into outgoing emails when `HOST_URL_APP` is missing
 * (`fondo_api/templatetags/env_var.py` uses `.get`). v2 validates the whole environment
 * once, at boot, and reports every problem at once.
 */
export const envSchema = z.object({
  // --- runtime -------------------------------------------------------------
  NODE_ENV: z.enum(ENVIRONMENTS).default('development'),
  /** v1's `settings.ENVIRONMENT`. Defaults to NODE_ENV when unset. */
  ENVIRONMENT: z.enum(ENVIRONMENTS).optional(),
  /** v1 serves gunicorn on 0.0.0.0:8443 (`scripts/run-server.sh`). */
  PORT: z.coerce.number().int().positive().default(8443),

  // --- database ------------------------------------------------------------
  DATABASE_URL: nonEmpty('DATABASE_URL').startsWith(
    'postgres',
    'DATABASE_URL must be a PostgreSQL connection string',
  ),

  // --- AWS -----------------------------------------------------------------
  /** v1: `os.environ['AWS_REGION']` — KeyError at import when missing. */
  AWS_REGION: nonEmpty('AWS_REGION'),
  /** v1: `os.environ['DEFAULT_FROM_EMAIL']` — KeyError at import when missing. */
  DEFAULT_FROM_EMAIL: nonEmpty('DEFAULT_FROM_EMAIL'),
  /**
   * v1: `os.environ.get('NOTIFICATIONS_QUEUE_URL', None)` — optional, and a missing value
   * degrades to a failed publish that is swallowed. Kept optional for parity.
   */
  NOTIFICATIONS_QUEUE_URL: z.string().trim().min(1).optional(),

  // --- outbound links ------------------------------------------------------
  /**
   * Used by the `{% host %}` template tag in every Spanish email.
   * Required in v2 (deviation P0-D1) — see docs/phase-0-deviations.md.
   */
  HOST_URL_APP: nonEmpty('HOST_URL_APP'),

  // --- storage -------------------------------------------------------------
  /** v1 hardcodes the bucket name "fonmon" in `fondo_api/services/file.py`. */
  GCS_BUCKET: z.string().trim().min(1).default('fonmon'),

  // --- localisation --------------------------------------------------------
  /** v1: `settings.LANGUAGE_LOCALE = 'es'`. */
  LANGUAGE_LOCALE: z.literal('es').default('es'),
  /** v1: `settings.TIME_ZONE = 'America/Bogota'` with `USE_TZ = True`. */
  TIME_ZONE: z.string().trim().min(1).default('America/Bogota'),
});

export type Env = z.infer<typeof envSchema>;
