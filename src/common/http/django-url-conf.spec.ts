import { DJANGO_URL_CONF, decodePathInfo, resolveDjangoUrl } from './django-url-conf';

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
        varyAccept: true,
      });
    });

    it('gives ObtainAuthToken no `Vary: Accept` — it declares a single renderer', () => {
      expect(resolveDjangoUrl('/api-token-auth')?.drf).toEqual({
        allow: 'POST, OPTIONS',
        varyAccept: false,
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
