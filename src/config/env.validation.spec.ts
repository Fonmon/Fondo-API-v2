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
    // ⚠️ Phase 7b: the scheduler is OFF unless a deployment says otherwise. v1's runner is a
    // separate `celery beat` container that the web image never starts, and this default is
    // how v2 keeps that property. A `true` default would make every replica a runner.
    expect(env.SCHEDULER_ENABLED).toBe(false);
  });

  describe('SCHEDULER_ENABLED (Phase 7b)', () => {
    it.each(['true', 'TRUE', 'True', '1', 'yes', 'on', ' true '])(
      'reads %p as enabled',
      (value) => {
        expect(validateEnv({ ...MINIMAL_ENV, SCHEDULER_ENABLED: value }).SCHEDULER_ENABLED).toBe(
          true,
        );
      },
    );

    it.each(['false', '0', 'no', 'off', 'FALSE', 'Off', ' no '])(
      'reads %p as disabled',
      (value) => {
        expect(validateEnv({ ...MINIMAL_ENV, SCHEDULER_ENABLED: value }).SCHEDULER_ENABLED).toBe(
          false,
        );
      },
    );

    /**
     * ⚠️ **Condition C70.** This block used to assert the opposite — `'maybe'`, `'enabled'`
     * and `''` were pinned as "disabled", so the spec itself certified that
     * `SCHEDULER_ENABLED=ture` silently disables the scheduler. Zero instances is the
     * cutover mistake `docs/phase-7b-deviations.md` §7.2 names as *most likely*, because it
     * is the default: nothing errors, nobody holds the flag, and reminders stop being sent
     * and (from Phase 6) CAPs stop being closed, with nothing in any log.
     */
    it.each(['ture', 'maybe', 'enabled', 'TRUE!', 'y', 't', '2'])(
      'refuses %p at boot rather than reading it as disabled (C70)',
      (value) => {
        expect(() => validateEnv({ ...MINIMAL_ENV, SCHEDULER_ENABLED: value })).toThrow(
          EnvValidationError,
        );
        expect(() => validateEnv({ ...MINIMAL_ENV, SCHEDULER_ENABLED: value })).toThrow(
          /SCHEDULER_ENABLED/,
        );
      },
    );

    /**
     * Present-but-empty is the *same* accident as the typo — `SCHEDULER_ENABLED=` in a unit
     * file, or `SCHEDULER_ENABLED=${FLAG}` with `FLAG` unset. Absent is different: that is
     * every replica which legitimately is not the runner, and it stays `false`.
     */
    it('refuses an empty value but still accepts the variable being absent', () => {
      expect(() => validateEnv({ ...MINIMAL_ENV, SCHEDULER_ENABLED: '' })).toThrow(
        EnvValidationError,
      );
      expect(() => validateEnv({ ...MINIMAL_ENV, SCHEDULER_ENABLED: '   ' })).toThrow(
        EnvValidationError,
      );
      expect(validateEnv({ ...MINIMAL_ENV }).SCHEDULER_ENABLED).toBe(false);
    });

    /** The message has to name the variable *and* say what to do, or it is a riddle. */
    it('names the variable and the accepted words in the boot failure', () => {
      try {
        validateEnv({ ...MINIMAL_ENV, SCHEDULER_ENABLED: 'ture' });
        throw new Error('expected validateEnv to throw');
      } catch (error) {
        const message = (error as EnvValidationError).message;
        expect(message).toContain('SCHEDULER_ENABLED');
        expect(message).toContain('true/1/yes/on');
        expect(message).toContain('false/0/no/off');
        expect(message).toContain("'ture'");
      }
    });
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
