import { DJANGO_URL_CONF, decodePathInfo, resolveDjangoUrl } from './django-url-conf';
import { BROWSABLE_API_RENDERER, JSON_RENDERER } from './drf-content-negotiation';

/**
 * The URL table is the whole of condition **C9**, so it is tested as a table: every status
 * asserted here was read off the running v1 (`gunicorn`, `DEBUG=False`) with an unauthenticated
 * request, where a **401** means "Django resolved this URL and DRF then rejected the caller"
 * and a **404** means "Django never resolved it".
 */
describe('DJANGO_URL_CONF', () => {
  const resolves = (path: string): boolean => resolveDjangoUrl(path) !== null;

  describe('F2 — case sensitivity (Django `url()` vs Express `caseSensitive: false`)', () => {
    it('serves the path v1 serves', () => {
      expect(resolves('/api/notification/subscribe')).toBe(true);
    });

    it.each([
      '/API/notification/subscribe',
      '/Api/notification/subscribe',
      '/api/Notification/subscribe',
      '/api/SAVING-account',
      '/API-TOKEN-AUTH',
    ])('does not serve %s — v1 returns 404', (path) => {
      expect(resolves(path)).toBe(false);
    });

    it('leaves the *operation* segment case-insensitive, because v1 does', () => {
      // `[a-zA-Z]+` matches `SUBSCRIBE`; the view then falls through to its own empty 405.
      expect(resolves('/api/notification/SUBSCRIBE')).toBe(true);
    });
  });

  describe('P2-D5 — the operation constraint lives in the URL conf', () => {
    it.each(['/api/notification/sub1', '/api/notification/sub-scribe', '/api/notification/1'])(
      '404s %s before authentication',
      (path) => {
        expect(resolves(path)).toBe(false);
      },
    );

    it.each(['/api/notification/subscribe', '/api/notification/unsubscribe'])(
      'resolves %s',
      (path) => {
        expect(resolves(path)).toBe(true);
      },
    );

    it('rejects an empty operation — `+` is one-or-more', () => {
      expect(resolves('/api/notification/')).toBe(false);
      expect(resolves('/api/notification')).toBe(false);
    });
  });

  describe('S7 — the trailing slash is per route, not a rule', () => {
    it.each([
      // [path, resolves, v1 note]
      ['/api/loan', true, '^api/loan/?$'],
      ['/api/loan/', true, '^api/loan/?$'],
      ['/api/loan/5', true, '^api/loan/(?P<id>[0-9]+)$ — no /?'],
      ['/api/loan/5/', false, 'detail routes have no /?'],
      ['/api/user/5', true, '^api/user/(?P<id>-?[0-9]+)$'],
      ['/api/user/5/', false, '⚠️ a real soft delete in v2 if this resolved'],
      ['/api/user/-1', true, 'the `-1` sentinel is in the regex'],
      ['/api/user/apps', true, '^api/user/(?P<app>-?[a-zA-Z]+)$'],
      ['/api/user/activate/5', true, 'own pattern'],
      ['/api/user/activate/5/', false, 'no /?'],
      ['/api/activity/5', true, '^api/activity/(?P<id>[0-9]+)/?$'],
      ['/api/activity/5/', true, '⚠️ the one detail route that accepts it'],
      ['/api/activity/year', true, '^api/activity/year/?$'],
      ['/api/activity/year/', true, '^api/activity/year/?$'],
      ['/api/activity/year/2020', true, 'detail'],
      ['/api/activity/year/2020/', false, 'detail — no /?'],
      ['/api/file', true, 'collection'],
      ['/api/file/5', true, 'detail'],
      ['/api/file/5/', false, 'detail — no /?'],
      ['/api-token-auth', true, '^api-token-auth/?$'],
      ['/api-token-auth/', true, '^api-token-auth/?$'],
      ['/api-token-auth//', false, 'one optional slash, not two'],
      ['/password_reset/', true, 'slash is mandatory'],
      ['/password_reset', false, 'APPEND_SLASH 301s this instead'],
      ['/reset/done/', true, 'slash is mandatory'],
      ['/reset/MQ/abc-defg/', true, 'uidb64 / token pattern'],
      ['/reset/MQ/abc/', false, 'the token needs the `-`'],
    ])('%s resolves = %s (%s)', (path, expected) => {
      expect(resolves(path)).toBe(expected);
    });
  });

  describe('what is deliberately absent', () => {
    it('does not serve /api/alexa — Alexa is not migrated (plan §1)', () => {
      expect(resolves('/api/alexa')).toBe(false);
    });

    it('serves /health, which has no v1 counterpart (P0-D2)', () => {
      expect(resolves('/health')).toBe(true);
    });

    it('is fail-closed for anything else', () => {
      expect(resolves('/')).toBe(false);
      expect(resolves('/api')).toBe(false);
      expect(resolves('/api/')).toBe(false);
      expect(resolves('/admin/')).toBe(false);
      expect(resolves('/api/notification/subscribe/extra')).toBe(false);
      expect(resolves('//api/notification/subscribe')).toBe(false);
    });
  });

  describe('the DRF headers each view emits', () => {
    it('gives NotificationView `Allow: POST, OPTIONS` and `Vary: Accept`', () => {
      expect(resolveDjangoUrl('/api/notification/subscribe')?.drf).toEqual({
        allow: 'POST, OPTIONS',
        renderers: [JSON_RENDERER, BROWSABLE_API_RENDERER],
      });
    });

    it('gives ObtainAuthToken no `Vary: Accept` — it declares a single renderer', () => {
      expect(resolveDjangoUrl('/api-token-auth')?.drf).toEqual({
        allow: 'POST, OPTIONS',
        renderers: [JSON_RENDERER],
      });
    });

    it('gives the Django auth pages no DRF headers at all', () => {
      expect(resolveDjangoUrl('/password_reset/')?.drf).toBeNull();
    });

    it('lists HEAD only where the view implements `get` (Django aliases head to get)', () => {
      expect(resolveDjangoUrl('/api/user/5')?.drf?.allow).toBe('GET, PATCH, DELETE, HEAD, OPTIONS');
      expect(resolveDjangoUrl('/api/loan/5/paymentProjection')?.drf?.allow).toBe('POST, OPTIONS');
    });
  });

  describe('C20 — the table names the view, and first-match-wins decides which', () => {
    // These four patterns share a prefix and have *different* permission rules, so which one
    // matches is an authorisation decision. Each expectation is the view that answered on the
    // live v1, identified by the `Allow` header it returned for that path.
    it.each([
      ['/api/user', 'UserView'],
      ['/api/user/', 'UserView'],
      ['/api/user/power', 'UserAppsView'],
      ['/api/user/-power', 'UserAppsView'],
      ['/api/user/5', 'UserDetailView'],
      ['/api/user/-1', 'UserDetailView'],
      ['/api/user/activate/5', 'UserActivateView'],
    ])('%s resolves to %s', (path, view) => {
      expect(resolveDjangoUrl(path)?.view).toBe(view);
    });

    it('keeps UserAppsView ahead of UserDetailView, as fondo_api/urls.py:21-22 does', () => {
      const names = DJANGO_URL_CONF.map((entry) => entry.view);

      expect(names.indexOf('UserAppsView')).toBeLessThan(names.indexOf('UserDetailView'));
    });

    it('gives every v2-only pattern a null view, so no rule can key on it', () => {
      expect(resolveDjangoUrl('/health')?.view).toBeNull();
    });
  });

  describe('Consider C5 — the `$` transcription depends on Django >= 2.2.25', () => {
    // Python's `$` also matches immediately before a trailing newline, so `subscribe\n` would
    // have matched `^…/(?P<operation>[a-zA-Z]+)/?$` under `re.match`. That input is reachable:
    // gunicorn's `unquote_to_wsgi_str` turns `%0A` into a literal `\n` in `PATH_INFO` and
    // Django's `get_path_info` passes it through — both verified inside the v1 image.
    //
    // It resolves to a 404 in v1 anyway, because **Django 2.2.25+ `RegexPattern.match` uses
    // `re.fullmatch` for patterns ending in `$`** (the CVE-2021-44420 fix,
    // `django/urls/resolvers.py`). JavaScript's `$` is `fullmatch`-like already, so the
    // transcription is exact — but only against that Django version.
    //
    // ⚠️ These two cells exist so that a "simplification" of the table toward `search`-like
    // semantics, or a downgrade below 2.2.25, fails loudly instead of silently widening the
    // URL surface. Live v1 confirms 404 on all four of the paths below.
    it.each([
      '/api/notification/subscribe\n',
      '/password_reset/\n',
      '/api-token-auth\n',
      '/api/loan\n',
    ])('404s %j — a trailing newline is not a match (re.fullmatch)', (pathInfo) => {
      expect(resolveDjangoUrl(pathInfo)).toBeNull();
    });

    it('reaches that path from a real request target: %0A decodes to a literal newline', () => {
      expect(decodePathInfo('/api/notification/subscribe%0A')).toBe(
        '/api/notification/subscribe\n',
      );
      expect(resolveDjangoUrl(decodePathInfo('/api/notification/subscribe%0A'))).toBeNull();
    });

    it('still resolves the same path without the newline — the control', () => {
      expect(resolveDjangoUrl('/api/notification/subscribe')?.view).toBe('NotificationView');
    });
  });

  it('anchors every pattern at both ends — an unanchored one would widen the surface', () => {
    for (const entry of DJANGO_URL_CONF) {
      expect(entry.regex.source.startsWith('^')).toBe(true);
      expect(entry.regex.source.endsWith('$')).toBe(true);
      // A global regex would carry `lastIndex` between calls and match every other time.
      expect(entry.regex.flags).toBe('');
    }
  });
});

describe('decodePathInfo — WSGI PATH_INFO', () => {
  it('decodes an escaped segment, as v1 does (verified live: 401, not 404)', () => {
    expect(decodePathInfo('/api/notification/%73ubscribe')).toBe('/api/notification/subscribe');
  });

  it('decodes %2F into a separator, which makes the path stop resolving (v1: 404)', () => {
    expect(decodePathInfo('/api/notification/sub%2Fscribe')).toBe('/api/notification/sub/scribe');
    expect(resolveDjangoUrl(decodePathInfo('/api/notification/sub%2Fscribe'))).toBeNull();
  });

  it('decodes multi-byte UTF-8 across consecutive escapes', () => {
    expect(decodePathInfo('/api/notification/subscribe%C3%B1')).toBe(
      '/api/notification/subscribeñ',
    );
  });

  it('leaves an invalid escape alone instead of throwing (CPython `unquote` never raises)', () => {
    expect(decodePathInfo('/api/%zz/%2')).toBe('/api/%zz/%2');
  });

  it('replaces an undecodable byte rather than throwing (errors="replace")', () => {
    expect(decodePathInfo('/api/%C3')).toBe('/api/�');
  });
});
