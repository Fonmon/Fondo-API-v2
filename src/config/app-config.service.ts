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
