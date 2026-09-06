import type { Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';

/**
 * A request written straight onto the socket — the **required transport for every cell whose
 * subject is the request target** (URL conf, `APPEND_SLASH`, `PATH_INFO` decoding, `Location`,
 * forged `Host`). Promoted out of `http-edge.e2e-spec.ts` by condition **C27** (review S8).
 *
 * **Why it exists.** supertest/superagent parses and re-serialises the URL before it writes
 * the request line, and the rewrites it performs are exactly the transformations those cells
 * are testing. Measured against a bare echo server:
 *
 * | written in the test | actually sent by supertest |
 * |---|---|
 * | `/api/notification/subscribe#frag` | `/api/notification/subscribe` |
 * | `/api/./notification/subscribe` | `/api/notification/subscribe` |
 * | `/api/../api/notification/subscribe` | `/api/notification/subscribe` |
 * | `/api\notification\subscribe` | `/api/notification/subscribe` |
 * | `/api/notification/sub scribe` | `/api/notification/sub%20scribe` |
 *
 * The first three are the dangerous ones: neither server normalises dot segments, so a
 * supertest cell asserting a 404 for `/api/./x` would assert it against a *rewritten* target
 * and pass for the wrong reason. That is false-green #1 (N4, the stripped fragment) in a
 * different disguise. supertest is also unable to forge a `Host:` header at all, because Node
 * derives it from the connection — which C19's `ALLOWED_HOSTS` cells need.
 *
 * The harness is itself under test: `test/raw-request.harness.e2e-spec.ts` asserts that the
 * request line the server *received* is byte-identical to the string the caller wrote, for
 * every target in the table above, and asserts in the same file that supertest fails that
 * same check. A helper that exists because another transport lies is worthless unless
 * something proves this one does not (C27's self-check).
 */
export interface RawResponse {
  /** Everything the server wrote, as `latin1`, before any parsing. Empty if it wrote nothing. */
  raw: string;
  /** The numeric status from the status line. `NaN` when the server answered nothing at all. */
  status: number;
  /** The status line verbatim, e.g. `HTTP/1.1 301 Moved Permanently`. */
  statusLine: string;
  /** Convenience for `headers['location']`, the field most of these cells assert. */
  location: string | undefined;
  /** Lower-cased field names to trimmed values; repeats keep the last occurrence. */
  headers: Record<string, string>;
  /** The body as `latin1`, so byte counts survive; no charset decoding is attempted. */
  body: string;
}

/**
 * Binds a socket if the server has none. `app.init()` wires the app up but never listens;
 * supertest hides that by calling `listen(0)` per request, but a raw socket needs a real
 * port. One ephemeral listener is bound and reused — supertest then reuses the same address,
 * and `app.close()` tears it down.
 */
export async function listeningPort(server: Server): Promise<number> {
  if (!server.listening) {
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
  }
  return (server.address() as AddressInfo).port;
}

/**
 * Writes `${method} ${target} HTTP/1.1` and `headerLines` onto the socket **verbatim** — no
 * URL parsing, no re-encoding, no normalisation — and parses the response.
 *
 * @param server the listening (or listenable) HTTP server
 * @param target the request target, sent byte-for-byte as given
 * @param method the method token, sent byte-for-byte as given
 * @param headerLines a raw, already-CRLF-terminated header block. `Content-Length: 0` and
 *   `Connection: close` are appended after it, so a cell may forge a `Host:` freely.
 */
export async function rawRequest(
  server: Server,
  target: string,
  method = 'POST',
  headerLines = 'Host: localhost\r\n',
): Promise<RawResponse> {
  const port = await listeningPort(server);
  const raw = await new Promise<string>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(
        `${method} ${target} HTTP/1.1\r\n${headerLines}Content-Length: 0\r\n` +
          'Connection: close\r\n\r\n',
      );
    });
    let buffer = '';
    socket.setEncoding('latin1');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
    });
    socket.on('end', () => {
      resolve(buffer);
    });
    socket.on('error', reject);
  });

  return parseRawResponse(raw);
}

/**
 * Splits a raw response into {@link RawResponse}. Shared by {@link rawRequest} and
 * {@link rawExchange} so the two transports cannot disagree about what a status is.
 */
export function parseRawResponse(raw: string): RawResponse {
  const [rawHead, ...rest] = raw.split('\r\n\r\n');
  const head = rawHead.split('\r\n');
  const statusLine = head[0];
  const status = Number(statusLine.split(' ')[1]);
  const headers: Record<string, string> = {};
  for (const line of head.slice(1)) {
    const separator = line.indexOf(':');
    if (separator > 0) {
      headers[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1).trim();
    }
  }
  return {
    raw,
    status,
    statusLine,
    location: headers['location'],
    headers,
    body: rest.join('\r\n\r\n'),
  };
}

/**
 * {@link rawRequest} with the **request line** itself under the caller's control, and with
 * the request optionally split across several TCP writes.
 *
 * `rawRequest` still composes `${method} ${target} HTTP/1.1`, which is right for the cells
 * whose subject is the target. It cannot express a request line that is malformed *as a
 * line* — two bits instead of three, tabs for spaces, `http/1.1` in lower case — and those
 * are exactly the inputs gunicorn's parser sorts into 400s and 401s (parity finding **N1**).
 *
 * ⚠️ **It resolves on close, with whatever arrived — including nothing.** A server that
 * drops the connection without replying yields `raw === ''` and `status === NaN`, which is
 * the pre-fix behaviour N1 is about; a cell must assert the status it expects rather than
 * `expect(status).not.toBe(200)`, or a dropped connection reads as a pass.
 *
 * @param writes one write per element, in order, `delayMs` apart — a single-element array is
 *   one `write()` call, which is how a request normally arrives on loopback
 * @param delayMs the pause between writes; enough for the peer to have processed the first
 */
export async function rawExchange(
  server: Server,
  writes: readonly string[],
  delayMs = 100,
): Promise<RawResponse> {
  const port = await listeningPort(server);
  const raw = await new Promise<string>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      void (async () => {
        for (const [index, chunk] of writes.entries()) {
          if (index > 0) {
            await new Promise((tick) => setTimeout(tick, delayMs));
          }
          socket.write(chunk, 'latin1');
        }
      })();
    });
    let buffer = '';
    socket.setEncoding('latin1');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
    });
    socket.on('close', () => {
      resolve(buffer);
    });
    socket.on('error', reject);
  });
  return parseRawResponse(raw);
}

/**
 * Partially applies {@link rawRequest} to one server, resolved lazily so a suite can bind it
 * in `beforeAll` and still build the helper at describe time.
 *
 * ```ts
 * const raw = rawRequestFor(() => app.getHttpServer() as unknown as Server);
 * const { status } = await raw('/api/./loan');
 * ```
 */
export function rawRequestFor(
  getServer: () => Server,
): (target: string, method?: string, headerLines?: string) => Promise<RawResponse> {
  return (target, method, headerLines) => rawRequest(getServer(), target, method, headerLines);
}
