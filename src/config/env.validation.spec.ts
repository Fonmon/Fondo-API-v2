import { EnvValidationError, validateEnv } from './env.validation';

const MINIMAL_ENV = {
  DATABASE_URL: 'postgresql://fondouser:fondo@localhost:5432/fondodev?schema=public',
  AWS_REGION: 'us-east-2',
  DEFAULT_FROM_EMAIL: 'Fondo Montanez <no-reply@fonmon.minagle.com>',
  HOST_URL_APP: 'http://localhost:3000',
};

describe('validateEnv', () => {
  it('accepts a minimal valid environment and fills in v1 defaults', () => {
    const env = validateEnv({ ...MINIMAL_ENV });
    expect(env.NODE_ENV).toBe('development');
    // v1: gunicorn --bind 0.0.0.0:8443
    expect(env.PORT).toBe(8443);
    // v1: settings.LANGUAGE_LOCALE = 'es', settings.TIME_ZONE = 'America/Bogota'
    expect(env.LANGUAGE_LOCALE).toBe('es');
    expect(env.TIME_ZONE).toBe('America/Bogota');
    // v1 hardcodes the bucket name in services/file.py
    expect(env.GCS_BUCKET).toBe('fonmon');
  });

  it('fails fast on a missing DEFAULT_FROM_EMAIL — v1 raises KeyError at import', () => {
    const { DEFAULT_FROM_EMAIL: _omitted, ...withoutEmail } = MINIMAL_ENV;
    expect(() => validateEnv(withoutEmail)).toThrow(EnvValidationError);
    try {
      validateEnv(withoutEmail);
    } catch (error) {
      expect((error as EnvValidationError).message).toContain('DEFAULT_FROM_EMAIL');
      expect((error as EnvValidationError).message).toContain('required');
    }
  });

  it('fails fast on a missing AWS_REGION — v1 raises KeyError at import', () => {
    const { AWS_REGION: _omitted, ...withoutRegion } = MINIMAL_ENV;
    expect(() => validateEnv(withoutRegion)).toThrow(/AWS_REGION/);
  });

  it('reports EVERY problem at once instead of one per restart', () => {
    try {
      validateEnv({});
      throw new Error('expected validateEnv to throw');
    } catch (error) {
      const issues = (error as EnvValidationError).issues;
      expect(issues.join('\n')).toContain('DATABASE_URL');
      expect(issues.join('\n')).toContain('AWS_REGION');
      expect(issues.join('\n')).toContain('DEFAULT_FROM_EMAIL');
      expect(issues.join('\n')).toContain('HOST_URL_APP');
      expect(issues.length).toBeGreaterThanOrEqual(4);
    }
  });

  it('rejects an empty string as firmly as a missing value', () => {
    expect(() => validateEnv({ ...MINIMAL_ENV, DEFAULT_FROM_EMAIL: '   ' })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects a non-PostgreSQL DATABASE_URL', () => {
    expect(() => validateEnv({ ...MINIMAL_ENV, DATABASE_URL: 'mysql://x/y' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('rejects an unknown ENVIRONMENT rather than silently behaving like production', () => {
    expect(() => validateEnv({ ...MINIMAL_ENV, ENVIRONMENT: 'staging' })).toThrow(
      EnvValidationError,
    );
  });

  it('coerces PORT from its string form', () => {
    expect(validateEnv({ ...MINIMAL_ENV, PORT: '3000' }).PORT).toBe(3000);
    expect(() => validateEnv({ ...MINIMAL_ENV, PORT: 'nope' })).toThrow(EnvValidationError);
    expect(() => validateEnv({ ...MINIMAL_ENV, PORT: '0' })).toThrow(EnvValidationError);
  });

  it('keeps NOTIFICATIONS_QUEUE_URL optional, exactly as v1 does', () => {
    // v1: os.environ.get('NOTIFICATIONS_QUEUE_URL', None)
    expect(validateEnv({ ...MINIMAL_ENV }).NOTIFICATIONS_QUEUE_URL).toBeUndefined();
    expect(
      validateEnv({ ...MINIMAL_ENV, NOTIFICATIONS_QUEUE_URL: 'https://sqs/queue' })
        .NOTIFICATIONS_QUEUE_URL,
    ).toBe('https://sqs/queue');
  });

  it('ignores unrelated variables in the ambient environment', () => {
    expect(() => validateEnv({ ...MINIMAL_ENV, SOME_UNRELATED_VAR: 'x' })).not.toThrow();
  });

  it('produces a message that names the file-level fix, not a stack trace', () => {
    try {
      validateEnv({});
    } catch (error) {
      expect((error as Error).message).toMatch(/^Invalid environment configuration\./);
    }
  });
});
