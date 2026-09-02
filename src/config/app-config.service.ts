import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env, Environment } from './env.schema';

/**
 * Typed, non-optional accessors over the validated environment. Inject this rather than
 * `ConfigService` so consumers never have to deal with `string | undefined`.
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  private get<K extends keyof Env>(key: K): Env[K] {
    return this.config.get(key, { infer: true });
  }

  get nodeEnv(): Environment {
    return this.get('NODE_ENV');
  }

  /** v1's `settings.ENVIRONMENT`; falls back to `NODE_ENV` when unset. */
  get environment(): Environment {
    return this.config.get('ENVIRONMENT', { infer: true }) ?? this.nodeEnv;
  }

  get isTest(): boolean {
    return this.environment === 'test';
  }

  get port(): number {
    return this.get('PORT');
  }

  /**
   * v1's `settings.DEBUG`, which is a property of the settings *module*:
   * `development.py:18` and `test.py:14` set `True`, `production.py:16` sets `False`.
   *
   * Read by the `ALLOWED_HOSTS` port only — `get_host()` substitutes a localhost-only
   * allowlist when `DEBUG` is on and `ALLOWED_HOSTS` is empty. It is **not** a general
   * "show stack traces" switch: v2 renders the same JSON error bodies in every environment.
   */
  get debug(): boolean {
    return this.environment !== 'production';
  }

  /**
   * v1's `settings.ALLOWED_HOSTS`, per settings module (condition **C19**):
   *
   * ```python
   * development.py:15  ALLOWED_HOSTS = []
   * test.py:11         ALLOWED_HOSTS = []
   * production.py:13   ALLOWED_HOSTS = [os.environ.get('ALLOWED_HOST_DOMAIN'), '127.0.0.1']
   * ```
   *
   * An unset `ALLOWED_HOST_DOMAIN` is dropped rather than rendered as a string: v1's `None`
   * entry can never match, because `is_same_domain` returns `False` for a falsy pattern.
   * Measured — production with the variable unset serves `Host: 127.0.0.1` and 400s
   * `Host: localhost`. An *empty* value behaves identically, by the same guard.
   */
  get allowedHosts(): readonly string[] {
    if (this.environment !== 'production') {
      return [];
    }
    const domain = this.config.get('ALLOWED_HOST_DOMAIN', { infer: true });
    return domain === undefined ? ['127.0.0.1'] : [domain, '127.0.0.1'];
  }

  get databaseUrl(): string {
    return this.get('DATABASE_URL');
  }

  get awsRegion(): string {
    return this.get('AWS_REGION');
  }

  get defaultFromEmail(): string {
    return this.get('DEFAULT_FROM_EMAIL');
  }

  /** Optional in v1 too: a missing queue URL degrades to a swallowed publish failure. */
  get notificationsQueueUrl(): string | undefined {
    return this.config.get('NOTIFICATIONS_QUEUE_URL', { infer: true });
  }

  /** Value of the `{% host %}` template tag in the Spanish emails. */
  get hostUrlApp(): string {
    return this.get('HOST_URL_APP');
  }

  get gcsBucket(): string {
    return this.get('GCS_BUCKET');
  }

  get languageLocale(): 'es' {
    return this.get('LANGUAGE_LOCALE');
  }

  get timeZone(): string {
    return this.get('TIME_ZONE');
  }
}
