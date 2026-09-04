import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { listeningPort, rawRequest } from './support/raw-request';

/**
 * **C27 — the harness self-check** (review S8, false-green #1).
 *
 * `rawRequest` exists only because supertest silently rewrites the request target, which is
 * the subject of the URL-layer cells. That reasoning is worthless unless something proves
 * `rawRequest` itself transmits what it claims — otherwise the fix for a false green is a
 * second, unmeasured false green.
 *
 * So this file does not boot Nest at all. It stands up a bare `http.createServer` that echoes
 * back the **request line it received** and compares that line to the string the test wrote:
 *
 *  * §1 asserts `rawRequest` is byte-faithful for every target in the S8 rewrite table;
 *  * §2 asserts **supertest is not**, against the same echo server — the positive control. If
 *    superagent is ever fixed upstream, §2 fails and tells us the helper's justification has
 *    changed, which is the signal we want rather than silence;
 *  * §3 covers what supertest cannot express at all: a forged `Host:` (C19) and a method
 *    token.
 *
 * Nothing here touches the app, the database or the fixture.
 */
describe('C27 — raw-request harness self-check', () => {
  let echo: Server;
  let received: string[];

  beforeAll(async () => {
    received = [];
    echo = createServer((req: IncomingMessage, res: ServerResponse) => {
      const line = `${req.method} ${req.url}`;
      received.push(line);
      req.resume();
      req.on('end', () => {
        const payload = Buffer.from(line, 'latin1');
        // An explicit Content-Length: chunked framing would put hex sizes in the body the
        // raw transport reads back, and this file is about bytes.
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': payload.length });
        res.end(payload);
      });
    });
    // A malformed request line never reaches the handler; record why, then answer as Node's
    // default `clientError` would, so the §2 cell can assert on it deterministically.
    echo.on('clientError', (error: NodeJS.ErrnoException, socket) => {
      received.push(`CLIENT-ERROR ${error.code ?? 'UNKNOWN'}`);
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    });
    await new Promise<void>((resolve) => {
      echo.listen(0, '127.0.0.1', resolve);
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      echo.close((error) => (error ? reject(error) : resolve()));
    });
  });

  beforeEach(() => {
    received = [];
  });

  const origin = (): string => `http://127.0.0.1:${(echo.address() as AddressInfo).port}`;

  /**
   * The S8 rewrite table, re-measured here rather than copied: `[what the cell writes, what
   * supertest actually sends]`. §1 asserts the left column survives `rawRequest`; §2 asserts
   * supertest produces the right column.
   *
   * The backslash row of the original S8 table is **not** here: re-measuring showed the raw
   * socket transmits `\` verbatim and Node's parser accepts it (200), so it belongs in
   * {@link VERBATIM_TARGETS}. The literal-space row is not here either — see §2, where it is
   * a 400, because a bare space cannot appear in a request target on the wire at all.
   */
  const REWRITE_TABLE: ReadonlyArray<readonly [string, string]> = [
    ['/api/notification/subscribe#frag', '/api/notification/subscribe'],
    ['/api/./notification/subscribe', '/api/notification/subscribe'],
    ['/api/../api/notification/subscribe', '/api/notification/subscribe'],
  ];

  /**
   * Targets that must reach the server unchanged. The percent-encoded entries are the ones
   * the existing F2/N3/C9 cells depend on surviving; the last three are shapes a URL-conf
   * cell asserts a 404 for, and would assert against a rewritten target under supertest.
   */
  const VERBATIM_TARGETS: readonly string[] = [
    '/api/%6Eotification/subscribe',
    '/api/notification/subscribe%2F',
    '/api/notificaci%C3%B3n/subscribe',
    '/api/notification/subscribe%0A',
    '/api/notification/subscribe%23frag',
    '//api/notification/subscribe',
    '/API/Notification/Subscribe',
    '/password_reset?a=1#frag',
    '/api\\notification\\subscribe',
  ];

  describe('§1 — rawRequest writes the request target byte-for-byte', () => {
    it.each(REWRITE_TABLE.map(([written]) => written))(
      'transmits %p unchanged, where supertest rewrites it',
      async (target) => {
        const response = await rawRequest(echo, target, 'POST');

        expect(response.status).toBe(200);
        // Both halves: what the server parsed, and what it echoed back through the transport.
        expect(received).toEqual([`POST ${target}`]);
        expect(response.body).toBe(`POST ${target}`);
      },
    );

    it.each(VERBATIM_TARGETS)('transmits %p unchanged', async (target) => {
      const response = await rawRequest(echo, target, 'POST');

      expect(response.status).toBe(200);
      expect(received).toEqual([`POST ${target}`]);
      expect(response.body).toBe(`POST ${target}`);
    });

    it('parses the status line, headers and body of the response', async () => {
      const response = await rawRequest(echo, '/api/loan', 'POST');

      expect(response.statusLine).toBe('HTTP/1.1 200 OK');
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('text/plain');
      expect(response.location).toBeUndefined();
      expect(response.body).toBe('POST /api/loan');
    });
  });

  describe('§2 — the positive control: supertest does not', () => {
    it.each(REWRITE_TABLE)(
      'supertest turns %p into %p, which is why the URL cells may not use it',
      async (written, actuallySent) => {
        await request(origin()).post(written);

        expect(received).toEqual([`POST ${actuallySent}`]);
        expect(received[0]).not.toBe(`POST ${written}`);
      },
    );

    it('the two transports disagree on the same target, in the same run', async () => {
      // The whole of S8 in one cell: two transports, one written target, two request lines.
      await request(origin()).post('/api/./notification/subscribe');
      const raw = await rawRequest(echo, '/api/./notification/subscribe', 'POST');

      expect(received).toEqual([
        'POST /api/notification/subscribe',
        'POST /api/./notification/subscribe',
      ]);
      expect(raw.body).toBe('POST /api/./notification/subscribe');
    });

    it('supertest converts a backslash to a slash; the raw socket sends the backslash', async () => {
      await request(origin()).post('/api\\notification\\subscribe');
      const raw = await rawRequest(echo, '/api\\notification\\subscribe', 'POST');

      expect(received).toEqual([
        'POST /api/notification/subscribe',
        'POST /api\\notification\\subscribe',
      ]);
      expect(raw.status).toBe(200);
    });

    /**
     * The one row where the raw transport cannot help — and the reason `rawRequest` must
     * never silently encode. A literal space *is* the request-line delimiter, so Node's
     * parser rejects the line outright: the cell gets a loud 400 and a `CLIENT-ERROR`, where
     * supertest quietly sends `%20` and the cell passes having never tested a space.
     */
    it('supertest percent-encodes a literal space; the raw socket gets a parse error', async () => {
      await request(origin()).post('/api/notification/sub scribe');
      expect(received).toEqual(['POST /api/notification/sub%20scribe']);

      received = [];
      const raw = await rawRequest(echo, '/api/notification/sub scribe', 'POST');
      expect(raw.status).toBe(400);
      expect(received).toEqual(['CLIENT-ERROR HPE_INVALID_CONSTANT']);
    });
  });

  describe('§3 — what supertest cannot express at all', () => {
    it('sends a forged Host header, which C19’s ALLOWED_HOSTS cells require', async () => {
      const hosts: (string | undefined)[] = [];
      const spy = createServer((req: IncomingMessage, res: ServerResponse) => {
        hosts.push(req.headers.host);
        req.resume();
        res.writeHead(200, { 'content-length': 0 });
        res.end();
      });
      try {
        await rawRequest(spy, '/password_reset', 'POST', 'Host: evil.test\r\n');
        // Node derives `Host` from the connection, so supertest can only ever send this one.
        await request(`http://127.0.0.1:${(spy.address() as AddressInfo).port}`).post(
          '/password_reset',
        );

        expect(hosts[0]).toBe('evil.test');
        expect(hosts[1]).toMatch(/^127\.0\.0\.1:\d+$/);
      } finally {
        await new Promise<void>((resolve) => spy.close(() => resolve()));
      }
    });

    it('sends the method token verbatim', async () => {
      await rawRequest(echo, '/api/loan', 'OPTIONS');
      expect(received).toEqual(['OPTIONS /api/loan']);
    });

    it('listeningPort binds an unbound server and is idempotent on a bound one', async () => {
      const idle = createServer((req: IncomingMessage, res: ServerResponse) => {
        req.resume();
        res.end();
      });
      try {
        expect(idle.listening).toBe(false);
        const first = await listeningPort(idle);
        expect(idle.listening).toBe(true);
        expect(await listeningPort(idle)).toBe(first);
      } finally {
        await new Promise<void>((resolve) => idle.close(() => resolve()));
      }
    });
  });
});
