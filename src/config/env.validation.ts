import { envSchema, type Env } from './env.schema';

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(
      [
        'Invalid environment configuration. Fix the following and restart:',
        ...issues.map((issue) => `  - ${issue}`),
      ].join('\n'),
    );
    this.name = 'EnvValidationError';
  }
}

/**
 * `@nestjs/config` validation hook. Runs once, at module initialisation, so a bad
 * environment aborts the boot with a single readable report instead of surfacing later as
 * an undefined value halfway through a request.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.join('.') || '(root)';
      return `${path}: ${issue.message}`;
    });
    throw new EnvValidationError(issues);
  }
  return result.data;
}
