import {
  gunicornBadRequest,
  gunicornWriteError,
  parseGunicornRequestLine,
} from './gunicorn-request-line';

/**
 * Every expectation here is a byte the **running v1** produced.
 *
 * Captured on 2026-09-06 from the pinned container `fondo-v1-p4` (gunicorn 19.9.0 /
 * Django 2.2.27 / CPython 3.9) on `127.0.0.1:8451`, over a **raw socket** — curl cannot send
 * an arbitrary method token, and `curl --head` cannot see a body-less error page. Each case
 * below records the total response size and the `Content-Length` v1 sent, so a change to the
 * template is caught by more than a string compare.
 */
describe('gunicorn 19.9 request-line parsing (parity finding N1)', () => {
  describe('parseGunicornRequestLine — what reaches the WSGI app', () => {
    it.each([
      ['FROB /api/activity/year HTTP/1.1', 'FROB', '/api/activity/year', 1, 1],
      ['BREW /api/activity/year HTTP/1.1', 'BREW', '/api/activity/year', 1, 1],
      ['CONNECT /api/activity/year HTTP/1.1', 'CONNECT', '/api/activity/year', 1, 1],
      ['ABC /x HTTP/1.1', 'ABC', '/x', 1, 1],
      // `$-_` is a range, U+0024..U+005F — all four of these are valid methods in v1.
      ['A-C /x HTTP/1.1', 'A-C', '/x', 1, 1],
      ['A_C /x HTTP/1.1', 'A_C', '/x', 1, 1],
      ['A.C /x HTTP/1.1', 'A.C', '/x', 1, 1],
      ['A$C /x HTTP/1.1', 'A$C', '/x', 1, 1],
      ['GET /x HTTP/1.0', 'GET', '/x', 1, 0],
    ])(
      'accepts %p — v1 answered 401, i.e. it reached the view',
      (line, method, uri, major, minor) => {
        expect(parseGunicornRequestLine(line)).toEqual({
          ok: true,
          method,
          uri,
          versionMajor: major,
          versionMinor: minor,
        });
      },
    );

    it('sets no upper bound on the method: `{3,20}` is a prefix match, and v1 answered 401 to a 24-character token', () => {
      const parsed = parseGunicornRequestLine(
        'FROBNICATORFROBNICATOR12 /api/activity/year HTTP/1.1',
      );

      expect(parsed).toEqual({
        ok: true,
        method: 'FROBNICATORFROBNICATOR12',
        uri: '/api/activity/year',
        versionMajor: 1,
        versionMinor: 1,
      });
    });

    it('uppercases the method after the check, as `parse_request_line` does', () => {
      // The regex rejects lowercase, so the only way to reach `.upper()` is a token that is
      // already upper-case — pinned so a future "tolerant" edit cannot pass `frob` through.
      expect(parseGunicornRequestLine('frob /x HTTP/1.1')).toEqual({
        ok: false,
        message: "Invalid Method 'Invalid HTTP method: 'frob''",
      });
    });

    it.each([
      ['tabs', 'FROB\t/api/activity/year\tHTTP/1.1'],
      ['runs of spaces', 'FROB   /api/activity/year   HTTP/1.1'],
      ['a leading space', ' FROB /api/activity/year HTTP/1.1'],
    ])(
      'splits on %s, because `split(None, 2)` does — v1 answered 401 to all three',
      (_label, line) => {
        expect(parseGunicornRequestLine(line)).toMatchObject({
          ok: true,
          method: 'FROB',
          uri: '/api/activity/year',
        });
      },
    );

    it('keeps the remainder verbatim after two splits, trailing whitespace included', () => {
      expect(parseGunicornRequestLine('FROB /x HTTP/1.1 junk')).toEqual({
        ok: true,
        method: 'FROB',
        uri: '/x',
        versionMajor: 1,
        versionMinor: 1,
      });
    });
  });

  describe('parseGunicornRequestLine — what gunicorn refuses with a 400', () => {
    it.each([
      ['X', "Invalid Method 'Invalid HTTP method: 'X''"],
      ['AB', "Invalid Method 'Invalid HTTP method: 'AB''"],
      ['get', "Invalid Method 'Invalid HTTP method: 'get''"],
      ['Get', "Invalid Method 'Invalid HTTP method: 'Get''"],
    ])(
      'refuses the method %p — fewer than three characters, or not upper-case',
      (method, message) => {
        expect(parseGunicornRequestLine(`${method} /api/activity/year HTTP/1.1`)).toEqual({
          ok: false,
          message,
        });
      },
    );

    it('refuses a request line with fewer than three bits', () => {
      expect(parseGunicornRequestLine('FROB /api/activity/year')).toEqual({
        ok: false,
        message: "Invalid Request Line 'Invalid HTTP request line: 'FROB /api/activity/year''",
      });
    });

    it('reports the *first* bit as the method when a space splits the token — v1: `FR`', () => {
      expect(parseGunicornRequestLine('FR OB /api/activity/year HTTP/1.1')).toEqual({
        ok: false,
        message: "Invalid Method 'Invalid HTTP method: 'FR''",
      });
    });

    it.each([
      ['HTTP/9', "Invalid HTTP Version 'Invalid HTTP Version: 'HTTP/9''"],
      ['http/1.1', "Invalid HTTP Version 'Invalid HTTP Version: 'http/1.1''"],
    ])('refuses the version %p', (version, message) => {
      expect(parseGunicornRequestLine(`FROB /api/activity/year ${version}`)).toEqual({
        ok: false,
        message,
      });
    });

    it('checks the method before the version, as the source orders them', () => {
      expect(parseGunicornRequestLine('get /x HTTP/9')).toEqual({
        ok: false,
        message: "Invalid Method 'Invalid HTTP method: 'get''",
      });
    });
  });

  describe('gunicornWriteError — the bytes `util.write_error` puts on the socket', () => {
    /** `${method}` → the whole response v1 sent, measured. */
    const measured: Record<string, { total: number; contentLength: number }> = {
      X: { total: 275, contentLength: 182 },
      get: { total: 277, contentLength: 184 },
      Get: { total: 277, contentLength: 184 },
      AB: { total: 276, contentLength: 183 },
    };

    it.each(Object.keys(measured))('reproduces v1 byte for byte for the method %p', (method) => {
      const parsed = parseGunicornRequestLine(`${method} /api/activity/year HTTP/1.1`);
      if (parsed.ok) {
        throw new Error('the fixture must be a rejected request line');
      }

      const response = gunicornBadRequest(parsed.message);

      expect(response.toString('latin1')).toBe(
        'HTTP/1.1 400 Bad Request\r\n' +
          'Connection: close\r\n' +
          'Content-Type: text/html\r\n' +
          `Content-Length: ${measured[method].contentLength}\r\n` +
          '\r\n' +
          '<html>\n' +
          '  <head>\n' +
          '    <title>Bad Request</title>\n' +
          '  </head>\n' +
          '  <body>\n' +
          '    <h1><p>Bad Request</p></h1>\n' +
          `    Invalid Method &#x27;Invalid HTTP method: &#x27;${method}&#x27;&#x27;\n` +
          '  </body>\n' +
          '</html>\n',
      );
      expect(response.length).toBe(measured[method].total);
    });

    it('matches v1 on the invalid-request-line page — 216 bytes of HTML, 309 on the wire', () => {
      const parsed = parseGunicornRequestLine('FROB /api/activity/year');
      if (parsed.ok) {
        throw new Error('the fixture must be a rejected request line');
      }

      const response = gunicornBadRequest(parsed.message);

      expect(response.length).toBe(309);
      expect(response.toString('latin1')).toContain('Content-Length: 216\r\n');
      expect(response.toString('latin1')).toContain(
        '    Invalid Request Line &#x27;Invalid HTTP request line: ' +
          '&#x27;FROB /api/activity/year&#x27;&#x27;\n',
      );
    });

    it.each([
      ['HTTP/9', 287, 194],
      ['http/1.1', 289, 196],
    ])('matches v1 on the invalid-version page for %p', (version, total, contentLength) => {
      const parsed = parseGunicornRequestLine(`FROB /api/activity/year ${version}`);
      if (parsed.ok) {
        throw new Error('the fixture must be a rejected request line');
      }

      const response = gunicornBadRequest(parsed.message);

      expect(response.length).toBe(total);
      expect(response.toString('latin1')).toContain(`Content-Length: ${contentLength}\r\n`);
    });

    it('carries no `Server` and no `Date` header — it is written before a Response exists', () => {
      const response = gunicornBadRequest("Invalid Method 'Invalid HTTP method: 'X''").toString(
        'latin1',
      );

      expect(response).not.toContain('Server:');
      expect(response).not.toContain('Date:');
    });

    it('escapes `&`, `<`, `>`, `"` and `\'` the way `html.escape(s, quote=True)` does', () => {
      const response = gunicornWriteError(400, 'Bad Request', `&<>"'`).toString('latin1');

      expect(response).toContain('    &amp;&lt;&gt;&quot;&#x27;\n');
    });

    it('counts `Content-Length` over the HTML only, so the header block is excluded', () => {
      const response = gunicornWriteError(400, 'Bad Request', 'hi').toString('latin1');
      const [head, body] = response.split('\r\n\r\n');

      expect(body.length).toBe(Number(/Content-Length: (\d+)/.exec(head)?.[1]));
    });
  });
});
