import type { ConfigService } from '@nestjs/config';
import { AppConfigService } from './app-config.service';
import type { Env } from './env.schema';

/**
 * The two settings-module-derived accessors added for condition **C19**. Everything else on
 * {@link AppConfigService} is a straight pass-through and is covered by the suites that use
 * it; `allowedHosts` and `debug` are the only ones that *derive* a v1 setting, and they
 * derive a security control.
 */
describe('AppConfigService — v1 settings-module derivations (C19)', () => {
  function service(env: Partial<Env>): AppConfigService {
    const config = {
      get: <K extends keyof Env>(key: K): Env[K] | undefined => env[key],
    } as unknown as ConfigService<Env, true>;
    return new AppConfigService(config);
  }

  describe('debug — v1 sets DEBUG per settings module', () => {
    it.each([
      ['development', true],
      ['test', true],
      ['production', false],
    ] as const)('%s -> %s', (environment, expected) => {
      expect(service({ NODE_ENV: environment }).debug).toBe(expected);
    });
  });

  describe('allowedHosts', () => {
    it.each(['development', 'test'] as const)(
      '%s.py sets ALLOWED_HOSTS = [] — get_host() then substitutes the DEBUG list',
      (environment) => {
        expect(
          service({ NODE_ENV: environment, ALLOWED_HOST_DOMAIN: 'ignored.test' }).allowedHosts,
        ).toEqual([]);
      },
    );

    it('production.py:13 — [ALLOWED_HOST_DOMAIN, "127.0.0.1"], in that order', () => {
      expect(
        service({ NODE_ENV: 'production', ALLOWED_HOST_DOMAIN: 'fonmon.minagle.com' }).allowedHosts,
      ).toEqual(['fonmon.minagle.com', '127.0.0.1']);
    });

    it('drops an unset ALLOWED_HOST_DOMAIN rather than rendering it — v1 has [None, ...]', () => {
      // Measured on live v1 with the variable unset: Host: localhost -> 400,
      // Host: 127.0.0.1 -> 401. `is_same_domain` refuses a falsy pattern.
      expect(service({ NODE_ENV: 'production' }).allowedHosts).toEqual(['127.0.0.1']);
    });

    it('keeps ENVIRONMENT ahead of NODE_ENV, as every other accessor does', () => {
      expect(
        service({ NODE_ENV: 'test', ENVIRONMENT: 'production', ALLOWED_HOST_DOMAIN: 'a.test' })
          .allowedHosts,
      ).toEqual(['a.test', '127.0.0.1']);
    });
  });
});
