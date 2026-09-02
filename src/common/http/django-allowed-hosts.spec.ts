import {
  DEBUG_ALLOWED_HOSTS,
  checkHost,
  effectiveAllowedHosts,
  isSameDomain,
  rawHostOf,
  splitDomainPort,
  validateHost,
} from './django-allowed-hosts';

/**
 * Condition **C19** / finding **S3** — the `ALLOWED_HOSTS` port.
 *
 * Every `expect` here is a status the live v1 produced for `GET /api/loan` with the stated
 * `ALLOWED_HOST_DOMAIN` and `Host:` (gunicorn 19.9.0, Django 2.2.27); the Python sources
 * quoted are `django/http/request.py` and `django/utils/http.py` from the same image.
 *
 * ⚠️ **This is a security control.** If a future refactor deletes the middleware, the e2e
 * cells in `test/http-edge.e2e-spec.ts` fail; if it "simplifies" the matching, these fail.
 * Both are intentional tripwires — see the class comment on `django-allowed-hosts.ts`.
 */
describe('ALLOWED_HOSTS (C19)', () => {
  describe('split_domain_port', () => {
    it.each([
      ['localhost', ['localhost', '']],
      ['LOCALHOST', ['localhost', '']],
      ['localhost:8443', ['localhost', '8443']],
      ['localhost.', ['localhost', '']],
      ['localhost.:8443', ['localhost', '8443']],
      ['127.0.0.1', ['127.0.0.1', '']],
      ['127.0.0.1:9999', ['127.0.0.1', '9999']],
      ['example.com.', ['example.com', '']],
    ])('lowercases, strips the port and the trailing dot: %s', (host, expected) => {
      expect(splitDomainPort(host)).toEqual(expected);
    });

    it.each([
      ['local_host', 'underscore is not in [a-z0-9.-]'],
      ['localhost:', 'the port group requires digits'],
      ['localhost:abc', 'the port group requires digits'],
      ['', 'the character class requires at least one character'],
      ['host name', 'space is not in the character class'],
      ['exam ple.com:80', 'space is not in the character class'],
    ])('returns an empty domain for an invalid host (%s — %s)', (host) => {
      expect(splitDomainPort(host)).toEqual(['', '']);
    });

    it.each([
      ['[::1]', ['[::1]', '']],
      ['[fe80::1]', ['[fe80::1]', '']],
      ['[::1]:8443', ['[::1]', '8443']],
    ])('keeps a bracketed IPv6 literal whole: %s', (host, expected) => {
      expect(splitDomainPort(host)).toEqual(expected);
    });

    it('does not strip a trailing dot from an IPv6 literal, because Django returns early', () => {
      // `if host[-1] == ']': return host, ''` happens before the trailing-dot rule.
      expect(splitDomainPort('[::1]')).toEqual(['[::1]', '']);
    });

    it('rejects a host with a trailing newline, where Python’s `$` would accept it', () => {
      // Documented narrowing: Python's `$` matches before a trailing newline. Unreachable
      // through any HTTP parser, and fail-closed if it were reachable.
      expect(splitDomainPort('localhost\n')).toEqual(['', '']);
    });
  });

  describe('is_same_domain', () => {
    it.each([
      ['localhost', 'localhost', true],
      ['localhost', 'LOCALHOST', true],
      ['evil.test', 'localhost', false],
      ['example.com', '.example.com', true],
      ['foo.example.com', '.example.com', true],
      ['a.b.example.com', '.example.com', true],
      ['notexample.com', '.example.com', false],
      ['xexample.com', '.example.com', false],
      ['example.com.d', '.example.com', false],
      ['example.com', '', false],
    ])('is_same_domain(%s, %s) === %s', (host, pattern, expected) => {
      expect(isSameDomain(host, pattern)).toBe(expected);
    });

    it('never matches an empty pattern — v1 production with ALLOWED_HOST_DOMAIN unset', () => {
      // `ALLOWED_HOSTS = [None, '127.0.0.1']`; measured: Host: localhost -> 400,
      // Host: 127.0.0.1 -> 401.
      expect(validateHost('localhost', ['', '127.0.0.1'])).toBe(false);
      expect(validateHost('127.0.0.1', ['', '127.0.0.1'])).toBe(true);
    });
  });

  describe('validate_host', () => {
    it('accepts anything against the * pattern', () => {
      expect(validateHost('anything.test', ['*'])).toBe(true);
      expect(validateHost('evil.test', ['*'])).toBe(true);
    });

    it('is a disjunction over the list', () => {
      expect(validateHost('127.0.0.1', ['localhost', '127.0.0.1'])).toBe(true);
      expect(validateHost('evil.test', ['localhost', '127.0.0.1'])).toBe(false);
    });
  });

  describe('get_host', () => {
    const PRODUCTION = ['localhost', '127.0.0.1'];

    it.each([
      'localhost',
      'LOCALHOST',
      'localhost:8443',
      'localhost.',
      'localhost.:8443',
      '127.0.0.1',
      '127.0.0.1:9999',
    ])('allows %s under ALLOWED_HOST_DOMAIN=localhost — v1: 401, i.e. served', (host) => {
      expect(checkHost(host, PRODUCTION)).toEqual({ allowed: true, host });
    });

    it.each(['evil.test', 'local_host', '[::1]', 'localhost:abc', 'localhost:', '.localhost', ''])(
      'refuses %s under ALLOWED_HOST_DOMAIN=localhost — v1: 400',
      (host) => {
        expect(checkHost(host, PRODUCTION).allowed).toBe(false);
      },
    );

    it('refuses an unparseable host even when * is allowed — `if domain and validate_host(...)`', () => {
      // Measured with ALLOWED_HOST_DOMAIN=*: `evil.test` -> 401 but `local_host` -> 400.
      expect(checkHost('evil.test', ['*', '127.0.0.1']).allowed).toBe(true);
      expect(checkHost('local_host', ['*', '127.0.0.1']).allowed).toBe(false);
      expect(checkHost('', ['*', '127.0.0.1']).allowed).toBe(false);
    });

    it.each([
      ['example.com', true],
      ['foo.example.com', true],
      ['a.b.example.com', true],
      ['EXAMPLE.COM', true],
      ['example.com.', true],
      ['notexample.com', false],
      ['xexample.com', false],
      ['example.com.d', false],
    ])('leading-dot wildcard: ALLOWED_HOST_DOMAIN=.example.com, Host: %s -> %s', (host, ok) => {
      expect(checkHost(host, ['.example.com', '127.0.0.1']).allowed).toBe(ok);
    });

    it('carries Django’s DisallowedHost message for a host that parses', () => {
      const verdict = checkHost('evil.test', PRODUCTION);
      expect(verdict).toEqual({
        allowed: false,
        message:
          "Invalid HTTP_HOST header: 'evil.test'. You may need to add 'evil.test' to ALLOWED_HOSTS.",
      });
    });

    it('carries the RFC 1034/1035 variant for a host that does not parse', () => {
      expect(checkHost('local_host', PRODUCTION)).toEqual({
        allowed: false,
        message:
          "Invalid HTTP_HOST header: 'local_host'. " +
          'The domain name provided is not valid according to RFC 1034/1035.',
      });
    });
  });

  describe('the DEBUG fallback', () => {
    it('substitutes localhost, 127.0.0.1 and [::1] when ALLOWED_HOSTS is empty and DEBUG is on', () => {
      // v1's development.py and test.py both set ALLOWED_HOSTS = [] with DEBUG = True.
      // Measured against api.settings.development: localhost/127.0.0.1/[::1] -> 401,
      // evil.test and local_host -> 400.
      expect(effectiveAllowedHosts([], true)).toEqual(['localhost', '127.0.0.1', '[::1]']);
      expect(checkHost('[::1]', DEBUG_ALLOWED_HOSTS).allowed).toBe(true);
      expect(checkHost('evil.test', DEBUG_ALLOWED_HOSTS).allowed).toBe(false);
    });

    it('does not substitute when ALLOWED_HOSTS is non-empty', () => {
      expect(effectiveAllowedHosts(['fonmon.test'], true)).toEqual(['fonmon.test']);
    });

    it('does not substitute when DEBUG is off — an empty production allowlist refuses everything', () => {
      expect(effectiveAllowedHosts([], false)).toEqual([]);
      expect(checkHost('localhost', effectiveAllowedHosts([], false)).allowed).toBe(false);
    });
  });

  describe('_get_raw_host', () => {
    it('reads HTTP_HOST', () => {
      expect(rawHostOf({ host: 'localhost:8443' })).toBe('localhost:8443');
    });

    it('ignores X-Forwarded-Host — USE_X_FORWARDED_HOST is False in v1 (P2-D9)', () => {
      expect(rawHostOf({ 'x-forwarded-host': 'evil.test' })).toBe('');
      expect(rawHostOf({ host: 'localhost', 'x-forwarded-host': 'evil.test' })).toBe('localhost');
    });

    it('treats a missing Host as unparseable, i.e. a 400 (P2-D9)', () => {
      // v1 would fall back to SERVER_NAME, which is `0.0.0.0` under its gunicorn bind and is
      // in no ALLOWED_HOSTS — measured 400 over a raw HTTP/1.0 socket, same as here.
      expect(rawHostOf({})).toBe('');
      expect(checkHost(rawHostOf({}), ['localhost', '127.0.0.1']).allowed).toBe(false);
    });
  });
});
