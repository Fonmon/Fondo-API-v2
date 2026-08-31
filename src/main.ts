import 'reflect-metadata';
import { config as loadDotEnv } from 'dotenv';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { NEST_APPLICATION_OPTIONS } from './bootstrap';
import { AppConfigService } from './config/app-config.service';
import { ENV_FILE_PATHS } from './config/env-files';
import { EnvValidationError, validateEnv } from './config/env.validation';

/**
 * Validates the environment **before** Nest starts building the DI graph.
 *
 * `AppConfigModule` validates too — this is the same check, run early so a misconfigured
 * deployment produces one readable paragraph on stderr instead of a framework stack trace.
 * v1's equivalent is a bare `KeyError: 'DEFAULT_FROM_EMAIL'` raised at import time.
 */
function assertEnvironmentIsValid(): void {
  loadDotEnv({ path: [...ENV_FILE_PATHS], quiet: true });
  try {
    validateEnv(process.env);
  } catch (error) {
    if (error instanceof EnvValidationError) {
      process.stderr.write(`\n${error.message}\n\n`);
      process.exit(1);
    }
    throw error;
  }
}

async function bootstrap(): Promise<void> {
  assertEnvironmentIsValid();

  const logger = new Logger('Bootstrap');
  // `NEST_APPLICATION_OPTIONS` disables Nest's body parser; `AppModule` installs DRF's
  // request-parsing middleware in its place. See `src/bootstrap.ts`.
  const app = await NestFactory.create(AppModule, NEST_APPLICATION_OPTIONS);

  // v1 sets `CORS_ORIGIN_ALLOW_ALL = True` (api/settings/base.py). Tightening it to an
  // allowlist is on the post-cutover backlog, not this migration.
  app.enableCors();
  app.enableShutdownHooks();

  const config = app.get(AppConfigService);
  // v1 serves gunicorn on 0.0.0.0:8443 (scripts/run-server.sh).
  await app.listen(config.port, '0.0.0.0');
  logger.log(`Fondo-API v2 listening on 0.0.0.0:${config.port} (${config.environment})`);
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(`Failed to start Fondo-API v2: ${String(error)}\n`);
  process.exit(1);
});
