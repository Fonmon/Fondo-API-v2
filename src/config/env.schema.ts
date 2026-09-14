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
 * The **closed** grammar for `SCHEDULER_ENABLED` — condition **C70**.
 *
 * Kept as a `Map` rather than two arrays so that "is this word recognised" and "what does it
 * mean" cannot drift apart: the refinement asks {@link Map.has} and the transform asks
 * {@link Map.get} of the *same* table, so a word can never be accepted and then silently read
 * as `false`. That drift is the failure this condition is about, one level down.
 */
const SCHEDULER_ENABLED_WORDS = new Map<string, boolean>([
  ['true', true],
  ['1', true],
  ['yes', true],
  ['on', true],
  ['false', false],
  ['0', false],
  ['no', false],
  ['off', false],
]);

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

  // --- host allowlist ------------------------------------------------------
  /**
   * v1's `api/settings/production.py:13`:
   * `ALLOWED_HOSTS = [os.environ.get('ALLOWED_HOST_DOMAIN'), '127.0.0.1']`.
   *
   * Deliberately **optional and untrimmed**, both for parity:
   *  * `os.environ.get` yields `None` when unset, and `is_same_domain` refuses a falsy
   *    pattern, so v1 with no `ALLOWED_HOST_DOMAIN` serves only `Host: 127.0.0.1` and 400s
   *    everything else. That is already fail-closed and loudly visible, so v2 reproduces it
   *    rather than refusing to boot — a required variable would be a *new* failure mode in
   *    the one place this migration is porting a security control.
   *  * trimming would make `' localhost'` an accepted spelling that v1 rejects.
   *
   * Accepts a bare domain (`fonmon.minagle.com`), Django's leading-dot subdomain wildcard
   * (`.minagle.com`) or `*`. Only read in `production`; `development` and `test` set
   * `ALLOWED_HOSTS = []`, which `DEBUG` then turns into localhost-only.
   */
  ALLOWED_HOST_DOMAIN: z.string().optional(),

  // --- signing -------------------------------------------------------------
  /**
   * v1's `settings.SECRET_KEY`, which `api/settings/production.py:11` reads from this exact
   * variable. `development.py` and `test.py` hardcode literals instead.
   *
   * **v2 does not share Django's token format** (plan, Phase 3: "v2 uses its own token
   * scheme"), so this is not needed for interoperability — reset links issued by v1 stop
   * working at cutover either way. It is needed because v2's own password-reset token is an
   * HMAC and an HMAC needs a key, and reusing the variable the deployment **already sets**
   * beats inventing a second one the operator has to remember.
   *
   * Optional here and required in production by {@link envSchema}'s refinement: v1 with an
   * unset `DJANGO_SECRET_KEY` raises `ImproperlyConfigured` the first time anything signs, so
   * v2 refusing to boot is the same failure moved earlier.
   */
  DJANGO_SECRET_KEY: z.string().min(1).optional(),

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
  /**
   * v1: `settings.TIME_ZONE = 'America/Bogota'` with `USE_TZ = True`, hardcoded.
   *
   * ⚠️ **Pinned, not configurable: condition C89 (Phase 8b review m2).** v2 decides calendar
   * dates in more than one place, and not all of them can read configuration:
   *
   *  * the scheduler cron's zone is a decorator argument, fixed at class definition
   *    (`scheduler.runner.ts`, `BOGOTA_TIME_ZONE`);
   *  * D48's birthday run date, `scheduleNotification`'s wall-clock-to-instant and every
   *    `todayInBogota()` default use the constant `BOGOTA_TIME_ZONE`;
   *  * the runner's "today" and `SchedulerTaskRepository`'s dedupe and selection queries read
   *    this variable.
   *
   * A free string here let a deployment move the second group without the first: tasks written
   * for one calendar and selected in another. Pinning the variable makes the constant the one
   * source. `src/scheduler/zone-single-source.spec.ts` fails if any other value is accepted, if
   * the cron zone differs from the configured one, or if D48's zone and the configured zone
   * decide differently.
   */
  TIME_ZONE: z.literal('America/Bogota').default('America/Bogota'),

  // --- scheduler (Phase 7b) ------------------------------------------------
  /**
   * Whether **this** process runs the scheduler cron (`SchedulerRunner`).
   *
   * ⚠️ **Defaults to `false`, and that is the multi-instance answer, not a convenience.**
   * v1's runner is `celery -A api beat`, a *separate container* from the gunicorn API — the
   * web image never runs it, however many replicas of the web image exist. v2 keeps the same
   * property with a flag instead of a second image: exactly one deployed process sets
   * `SCHEDULER_ENABLED=true`, and every other replica has no cron at all. Defaulting to
   * `false` also means no test, no local `npm run start`, and no scaled-out replica can
   * publish a payment reminder by accident.
   *
   * Defence in depth against the flag being set twice lives in the data layer:
   * `SchedulerTaskRepository.claim()` is an atomic
   * `UPDATE … WHERE id = ? AND processed = false`, so a second runner that loaded the same
   * row loses the claim and skips it. See `docs/phase-7b-deviations.md` §2.
   *
   * ## ⚠️ An unrecognised value **fails the boot** — condition **C70**
   *
   * This used to accept anything and fold it to `false`, and the spec *pinned* that
   * leniency (`'maybe'`, `'enabled'` and `''` were all asserted as "disabled"). The result
   * was that `SCHEDULER_ENABLED=ture` disabled the scheduler in silence: nothing errors,
   * nobody holds the flag, and reminders — and, from Phase 6, **CAP auto-closes** — simply
   * stop happening. `docs/phase-7b-deviations.md` §7.2 names zero-instance as the *most
   * likely* cutover mistake precisely because it is the default, and a lenient parser makes
   * a typo indistinguishable from the default.
   *
   * So the grammar is now closed and explicit:
   *
   * | value | result |
   * |---|---|
   * | **absent** | `false` — the 20 replicas that are not the runner, and the local default |
   * | `true` / `1` / `yes` / `on` (any case, surrounding whitespace trimmed) | `true` |
   * | `false` / `0` / `no` / `off` (same) | `false` |
   * | **anything else, including the empty string** | **boot fails** with this variable named |
   *
   * ⚠️ **Present-but-empty is a failure, not a synonym for absent.** `SCHEDULER_ENABLED=` in
   * a unit file or `SCHEDULER_ENABLED=${FLAG}` with `FLAG` unset is a templating accident,
   * and it is the *same* accident as the typo: someone meant to set the flag and did not.
   * Absent stays `false` because absent is what every non-runner replica legitimately is.
   */
  SCHEDULER_ENABLED: z
    .string()
    .optional()
    .superRefine((value, ctx) => {
      if (value === undefined || SCHEDULER_ENABLED_WORDS.has(value.trim().toLowerCase())) {
        return;
      }
      ctx.addIssue({
        code: 'custom',
        message:
          `SCHEDULER_ENABLED must be one of true/1/yes/on or false/0/no/off (received ` +
          `'${value}'). Leave it unset to disable. A value this parser does not recognise ` +
          'is refused rather than treated as false, because a silently-disabled scheduler ' +
          'stops sending reminders and closing CAPs with nothing in the log (C70).',
      });
    })
    .transform((value) => SCHEDULER_ENABLED_WORDS.get(value?.trim().toLowerCase() ?? '') ?? false),
});

/**
 * `DJANGO_SECRET_KEY` is mandatory in production and only there — mirroring v1, where
 * `development.py` and `test.py` carry a literal and only `production.py` reads the
 * environment.
 */
export const validatedEnvSchema = envSchema.superRefine((env, ctx) => {
  const environment = env.ENVIRONMENT ?? env.NODE_ENV;
  if (environment === 'production' && env.DJANGO_SECRET_KEY === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['DJANGO_SECRET_KEY'],
      message:
        'DJANGO_SECRET_KEY is required in production — password-reset tokens are signed with it',
    });
  }
});

export type Env = z.infer<typeof envSchema>;
