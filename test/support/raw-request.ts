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
  /** The numeric status from the status line. */
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
    status,
    statusLine,
    location: headers['location'],
    headers,
    body: rest.join('\r\n\r\n'),
  };
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
