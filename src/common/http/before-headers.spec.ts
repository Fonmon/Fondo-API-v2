import type { Response } from 'express';
import { DjangoStack, onBeforeHeaders, skipBeforeHeadersHooks } from './before-headers';
import { patchVaryHeaders } from './django-cors.middleware';

/**
 * Condition **C21** / finding **S1** — the response phase runs bottom-up, and "skip" means
 * "skip what is below me".
 *
 * The two `Vary` orders asserted below are the ones the round-3 parity sweep measured on the
 * live v1 (`docs/parity-phase-2.md` §R3.6). They are the reason this needed fixing before
 * Phase 3 rather than during it: they differ *only* by the depth of the layer that added
 * `Cookie`, so no per-route flag can express them and a FIFO list gets one of them wrong.
 */
describe('onBeforeHeaders — Django’s response phase (C21)', () => {
  function fakeResponse(): Response & { headers: Record<string, string> } {
    const headers: Record<string, string> = {};
    const response = {
      statusCode: 200,
      headers,
      setHeader(name: string, value: string) {
        headers[name] = String(value);
        return response;
      },
      getHeader(name: string) {
        return headers[name];
      },
      removeHeader(name: string) {
        delete headers[name];
      },
      writeHead() {
        return response;
      },
      end() {
        response.writeHead(response.statusCode);
        return response;
      },
    } as unknown as Response & { headers: Record<string, string> };
    return response;
  }

  /** Records the order hooks fired in. */
  function probe(response: Response, depth: number, label: string, log: string[]): void {
    onBeforeHeaders(response, depth as never, () => log.push(label));
  }

  describe('ordering', () => {
    it('runs deepest first — the reverse of v1’s MIDDLEWARE, i.e. of registration order', () => {
      const response = fakeResponse();
      const log: string[] = [];
      // Registered in request order, as `AppModule.configure` does.
      probe(response, DjangoStack.SESSION, 'session(2)', log);
      probe(response, DjangoStack.COMMON, 'common(3)', log);
      probe(response, DjangoStack.X_FRAME_OPTIONS, 'xframe(7)', log);
      probe(response, DjangoStack.CORS, 'cors(8)', log);
      probe(response, DjangoStack.VIEW, 'view(9)', log);

      response.end();

      expect(log).toEqual(['view(9)', 'cors(8)', 'xframe(7)', 'common(3)', 'session(2)']);
    });

    it('keeps registration order within one depth', () => {
      const response = fakeResponse();
      const log: string[] = [];
      probe(response, DjangoStack.VIEW, 'first', log);
      probe(response, DjangoStack.VIEW, 'second', log);
      probe(response, DjangoStack.VIEW, 'third', log);

      response.end();

      expect(log).toEqual(['first', 'second', 'third']);
    });

    it('runs the transport fixups last, above slot 1', () => {
      const response = fakeResponse();
      const log: string[] = [];
      probe(response, DjangoStack.TRANSPORT, 'transport(0)', log);
      probe(response, DjangoStack.SECURITY, 'security(1)', log);
      probe(response, DjangoStack.CORS, 'cors(8)', log);

      response.end();

      expect(log).toEqual(['cors(8)', 'security(1)', 'transport(0)']);
    });

    it('runs the hooks exactly once, however often writeHead is called', () => {
      const response = fakeResponse();
      const log: string[] = [];
      probe(response, DjangoStack.CORS, 'cors', log);

      response.writeHead(200);
      response.writeHead(200);
      response.end();

      expect(log).toEqual(['cors']);
    });
  });

  describe('the two Vary orders v1 produces, from depth alone', () => {
    it('GET /password_reset/ -> `Cookie, Origin` (view-level csrf_protect, below all eight)', () => {
      const response = fakeResponse();
      // `PasswordResetView`'s `csrf_protect` decorator sets the csrftoken cookie and patches
      // Vary from *inside* the view, i.e. deeper than every middleware.
      onBeforeHeaders(response, DjangoStack.VIEW, (finished) => {
        patchVaryHeaders(finished, ['Cookie']);
      });
      onBeforeHeaders(response, DjangoStack.CORS, (finished) => {
        patchVaryHeaders(finished, ['Origin']);
      });

      response.end();

      expect(response.headers['Vary']).toBe('Cookie, Origin');
    });

    it('GET /reset/<uid>/set-password/ -> `Origin, Cookie` (SessionMiddleware, slot 2)', () => {
      const response = fakeResponse();
      onBeforeHeaders(response, DjangoStack.CORS, (finished) => {
        patchVaryHeaders(finished, ['Origin']);
      });
      onBeforeHeaders(response, DjangoStack.SESSION, (finished) => {
        patchVaryHeaders(finished, ['Cookie']);
      });

      response.end();

      expect(response.headers['Vary']).toBe('Origin, Cookie');
    });

    it('is the same registration order in both cases — only the depths differ', () => {
      // Written out because it is the whole argument for the depth model: two responses whose
      // hooks are registered in the *same* order produce different, correct `Vary` values.
      const shallowFirst = fakeResponse();
      onBeforeHeaders(shallowFirst, DjangoStack.CORS, (finished) => {
        patchVaryHeaders(finished, ['Origin']);
      });
      onBeforeHeaders(shallowFirst, DjangoStack.VIEW, (finished) => {
        patchVaryHeaders(finished, ['Cookie']);
      });
      shallowFirst.end();

      expect(shallowFirst.headers['Vary']).toBe('Cookie, Origin');
    });
  });

  describe('skipBeforeHeadersHooks means “below me”, not “all”', () => {
    it('suppresses deeper hooks and keeps shallower ones', () => {
      const response = fakeResponse();
      const log: string[] = [];
      probe(response, DjangoStack.SECURITY, 'security(1)', log);
      probe(response, DjangoStack.SESSION, 'session(2)', log);
      probe(response, DjangoStack.COMMON, 'common(3)', log);
      probe(response, DjangoStack.CORS, 'cors(8)', log);
      probe(response, DjangoStack.VIEW, 'view(9)', log);

      // `CommonMiddleware`'s APPEND_SLASH 301: slot 3's own response phase still runs.
      skipBeforeHeadersHooks(response, DjangoStack.COMMON);
      response.end();

      expect(log).toEqual(['common(3)', 'session(2)', 'security(1)']);
    });

    it('the DisallowedHost 400 skips slot 3 too — it is raised, not returned', () => {
      const response = fakeResponse();
      const log: string[] = [];
      probe(response, DjangoStack.SESSION, 'session(2)', log);
      probe(response, DjangoStack.COMMON, 'common(3)', log);
      probe(response, DjangoStack.CORS, 'cors(8)', log);

      skipBeforeHeadersHooks(response, DjangoStack.SESSION);
      response.end();

      expect(log).toEqual(['session(2)']);
    });

    it('applies to hooks registered *after* the skip, not only before it', () => {
      // The old implementation marked the response "already run" instead of recording a
      // depth, so a later registration was silently dropped whatever its depth.
      const response = fakeResponse();
      const log: string[] = [];

      skipBeforeHeadersHooks(response, DjangoStack.COMMON);
      probe(response, DjangoStack.CORS, 'cors(8)', log);
      probe(response, DjangoStack.SECURITY, 'security(1)', log);
      response.end();

      expect(log).toEqual(['security(1)']);
    });

    it('keeps the shallowest floor when called more than once', () => {
      const response = fakeResponse();
      const log: string[] = [];
      probe(response, DjangoStack.SESSION, 'session(2)', log);
      probe(response, DjangoStack.COMMON, 'common(3)', log);

      skipBeforeHeadersHooks(response, DjangoStack.COMMON);
      skipBeforeHeadersHooks(response, DjangoStack.SESSION);
      response.end();

      expect(log).toEqual(['session(2)']);
    });

    it('never suppresses the transport fixups — no caller can be shallower than slot 1', () => {
      const response = fakeResponse();
      const log: string[] = [];
      probe(response, DjangoStack.TRANSPORT, 'transport(0)', log);
      probe(response, DjangoStack.CORS, 'cors(8)', log);

      skipBeforeHeadersHooks(response, DjangoStack.SECURITY);
      response.end();

      expect(log).toEqual(['transport(0)']);
    });
  });
});
