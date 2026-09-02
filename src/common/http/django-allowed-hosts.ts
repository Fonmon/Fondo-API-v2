/**
 * `ALLOWED_HOSTS` — `django.http.request.get_host` / `split_domain_port` / `validate_host`
 * and `django.utils.http.is_same_domain`, ported from the **installed Django 2.2.27** in the
 * v1 image, not from documentation. Review condition **C19** (finding S3).
 *
 * ## Why this exists at all
 *
 * `CommonMiddleware.process_request` (v1 `MIDDLEWARE` slot 3) calls `request.get_host()`
 * *before* the `APPEND_SLASH` check:
 *
 * ```python
 * host = request.get_host()                                   # middleware/common.py:47
 * must_prepend = settings.PREPEND_WWW and host and ...
 * ```
 *
 * `get_host()` raises `DisallowedHost` (a `SuspiciousOperation`) when the `Host` header is
 * not in `ALLOWED_HOSTS`, and `convert_exception_to_response` turns that into a **400**
 * ahead of the CORS preflight, the URL resolver and everything else. v2's first cut of the
 * `CommonMiddleware` port covered the `APPEND_SLASH` branch and correctly treated
 * `PREPEND_WWW` / `DISALLOWED_USER_AGENTS` as no-ops (both default/empty), but dropped the
 * one branch that *does* fire under v1's settings.
 *
 * ⚠️ **This is a security control, not a header nicety.** Phase 3's `PasswordResetView`
 * (`fondo_api/views/auth.py:37-42`) builds the emailed reset link's domain from
 * `get_current_site(request)`, i.e. from `request.get_host()`. Without the allowlist a forged
 * `Host:` header makes the service email a member a password-reset token pointing at the
 * attacker's domain. Do not remove or relax any of this without replacing it.
 *
 * ## Measured, not assumed
 *
 * Every row below was produced by the live v1 (`gunicorn 19.9.0`,
 * `DJANGO_SETTINGS_MODULE=api.settings.production`) answering `GET /api/loan`:
 *
 * | `ALLOWED_HOST_DOMAIN` | `Host:` | v1 |
 * |---|---|---|
 * | `localhost` | `localhost`, `LOCALHOST`, `localhost:8444`, `localhost.`, `localhost.:8444` | 401 (allowed) |
 * | `localhost` | `127.0.0.1`, `127.0.0.1:9999` | 401 (allowed — the second entry) |
 * | `localhost` | `evil.test`, `local_host`, `[::1]`, `localhost:abc`, `localhost:`, `.localhost`, empty, absent | **400** |
 * | `.example.com` | `example.com`, `foo.example.com`, `a.b.example.com`, `EXAMPLE.COM`, `example.com.` | 401 (allowed) |
 * | `.example.com` | `notexample.com`, `xexample.com`, `example.com.d` | **400** |
 * | `*` | `anything.test`, `evil.test` | 401 (allowed) |
 * | `*` | `local_host`, `localhost:`, empty | **400** — `if domain and validate_host(...)` |
 * | *unset* (`[None, '127.0.0.1']`) | `localhost` | **400** |
 * | *unset* | `127.0.0.1` | 401 |
 * | `development.py` (`[]` + `DEBUG`) | `localhost`, `127.0.0.1`, `[::1]` | 401 |
 * | `development.py` | `evil.test`, `local_host` | **400** |
 */

/**
 * `django.http.request.host_validation_re`, verbatim.
 *
 * ⚠️ **One deliberate narrowing.** Python's `$` also matches immediately before a trailing
 * newline, so `host_validation_re.match('evil.test\n')` succeeds in Django and fails here.
 * It cannot matter, and the reasoning is worth writing down because it is the same trap as
 * the URL table's `re.fullmatch` dependency (Consider C5):
 *
 *  * a bare `\n` cannot survive either HTTP parser inside a header value, so the input is
 *    unreachable to begin with;
 *  * and even if it arrived, Django would then run the *exact* comparison in
 *    {@link isSameDomain} against `'evil.test\n'`, which no pattern equals and no
 *    `.suffix` ends with — so the only pattern the laxer regex could let through is the
 *    literal `'*'`, which v1 never configures.
 *
 * The JS form is therefore stricter, in the fail-closed direction, on an unreachable input.
 */
const HOST_VALIDATION_RE = /^([a-z0-9.-]+|\[[a-f0-9]*:[a-f0-9.:]+\])(:\d+)?$/;

/** Django's `get_host()` verdict: either the host it would have returned, or its 400. */
export type HostCheck =
  | { readonly allowed: true; readonly host: string }
  | { readonly allowed: false; readonly message: string };

/**
 * The hosts Django validates against, after `get_host`'s `DEBUG` fallback.
 *
 * ```python
 * allowed_hosts = settings.ALLOWED_HOSTS
 * if settings.DEBUG and not allowed_hosts:
 *     allowed_hosts = ['localhost', '127.0.0.1', '[::1]']
 * ```
 *
 * v1's `development.py:15,18` and `test.py:11,14` both set `ALLOWED_HOSTS = []` **and**
 * `DEBUG = True`, so this branch is v1's real behaviour in two of its three settings
 * modules — verified live, `[::1]` included.
 */
export function effectiveAllowedHosts(
  allowedHosts: readonly string[],
  debug: boolean,
): readonly string[] {
  if (debug && allowedHosts.length === 0) {
    return DEBUG_ALLOWED_HOSTS;
  }
  return allowedHosts;
}

/** `django/http/request.py:97` — the literal list, in Django's order. */
export const DEBUG_ALLOWED_HOSTS: readonly string[] = Object.freeze([
  'localhost',
  '127.0.0.1',
  '[::1]',
]);

/**
 * `HttpRequest.get_host()`.
 *
 * ```python
 * domain, port = split_domain_port(host)
 * if domain and validate_host(domain, allowed_hosts):
 *     return host
 * msg = "Invalid HTTP_HOST header: %r." % host
 * ...
 * raise DisallowedHost(msg)
 * ```
 *
 * Note the `domain and` guard: an unparseable host is refused even when `ALLOWED_HOSTS`
 * contains `'*'` (verified live).
 *
 * @param rawHost `request.META['HTTP_HOST']`. `X-Forwarded-Host` is **not** consulted:
 *   `USE_X_FORWARDED_HOST` defaults to `False` and v1 never sets it. A missing `Host` header
 *   arrives here as `''` — see {@link rawHostOf}.
 */
export function checkHost(rawHost: string, allowedHosts: readonly string[]): HostCheck {
  const [domain] = splitDomainPort(rawHost);
  if (domain !== '' && validateHost(domain, allowedHosts)) {
    return { allowed: true, host: rawHost };
  }

  // The message Django logs to `django.security.DisallowedHost`. v2 logs it for the same
  // reason and never puts it in the response body (v1 does not either).
  const quoted = pythonRepr(rawHost);
  const detail =
    domain === ''
      ? ' The domain name provided is not valid according to RFC 1034/1035.'
      : ` You may need to add ${pythonRepr(domain)} to ALLOWED_HOSTS.`;
  return { allowed: false, message: `Invalid HTTP_HOST header: ${quoted}.${detail}` };
}

/**
 * `django.http.request.split_domain_port` — "Returned domain is lowercased. If the host is
 * invalid, the domain will be empty."
 */
export function splitDomainPort(rawHost: string): readonly [domain: string, port: string] {
  const host = rawHost.toLowerCase();

  if (!HOST_VALIDATION_RE.test(host)) {
    return ['', ''];
  }

  if (host.endsWith(']')) {
    // An IPv6 address with no port. Note that Django does **not** strip a trailing dot here.
    return [host, ''];
  }

  // `bits = host.rsplit(':', 1)` — at most one split, from the right.
  const separator = host.lastIndexOf(':');
  const domain = separator === -1 ? host : host.slice(0, separator);
  const port = separator === -1 ? '' : host.slice(separator + 1);

  // "Remove a trailing dot (if present) from the domain." — `localhost.` == `localhost`.
  return [domain.endsWith('.') ? domain.slice(0, -1) : domain, port];
}

/**
 * `django.http.request.validate_host`. Assumes `host` is already lowercased and portless,
 * which is what {@link splitDomainPort} guarantees.
 */
export function validateHost(host: string, allowedHosts: readonly string[]): boolean {
  return allowedHosts.some((pattern) => pattern === '*' || isSameDomain(host, pattern));
}

/**
 * `django.utils.http.is_same_domain`.
 *
 * ```python
 * if not pattern:
 *     return False
 * pattern = pattern.lower()
 * return (
 *     pattern[0] == '.' and (host.endswith(pattern) or host == pattern[1:]) or
 *     pattern == host
 * )
 * ```
 *
 * The falsy-pattern guard is load-bearing for v1's production settings:
 * `ALLOWED_HOSTS = [os.environ.get('ALLOWED_HOST_DOMAIN'), '127.0.0.1']` is `[None, ...]`
 * when the variable is unset, and `None` simply never matches — measured, `Host: localhost`
 * is a 400 in that configuration and `Host: 127.0.0.1` is not.
 *
 * `.example.com` matches `example.com` and `foo.example.com` but **not** `xexample.com`,
 * because the pattern keeps its leading dot for the `endswith` test. Also measured.
 */
export function isSameDomain(host: string, pattern: string): boolean {
  if (pattern === '') {
    return false;
  }
  const lowered = pattern.toLowerCase();
  return (
    (lowered.startsWith('.') && (host.endsWith(lowered) || host === lowered.slice(1))) ||
    lowered === host
  );
}

/**
 * `HttpRequest._get_raw_host()`, reduced to v1's settings.
 *
 * ```python
 * if settings.USE_X_FORWARDED_HOST and 'HTTP_X_FORWARDED_HOST' in self.META: ...
 * elif 'HTTP_HOST' in self.META: host = self.META['HTTP_HOST']
 * else: host = SERVER_NAME (+ ':' + SERVER_PORT when non-default)
 * ```
 *
 * ⚠️ Two knowing simplifications, both fail-closed and both registered as **P2-D9**:
 *
 *  1. `USE_X_FORWARDED_HOST` is `False` in v1 and there is no setting here to turn it on, so
 *     `X-Forwarded-Host` is ignored **unconditionally**. If v2 is ever deployed behind a
 *     proxy that rewrites the host, this is the line to revisit — deliberately, not by
 *     inheriting a framework default.
 *  2. The `SERVER_NAME` fallback for a request with no `Host` header (only reachable over
 *     HTTP/1.0) becomes `''`, i.e. an automatic 400. Under v1's deployment gunicorn binds
 *     `0.0.0.0`, so `SERVER_NAME` is `0.0.0.0`, which is in no `ALLOWED_HOSTS` — v1 answers
 *     **400** there too, verified over a raw socket. The two agree on every deployed
 *     configuration; they would differ only if the bind address were itself allow-listed.
 */
export function rawHostOf(headers: Readonly<Record<string, unknown>>): string {
  const host = headers['host'];
  return typeof host === 'string' ? host : '';
}

/**
 * `'%r' % s`, close enough for a log line. Python switches to double quotes when the value
 * itself contains a single quote; this always single-quotes and escapes. The string never
 * reaches a response body, so the difference is cosmetic in a log.
 */
function pythonRepr(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
