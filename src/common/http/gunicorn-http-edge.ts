import {
  IncomingMessage,
  ServerResponse,
  maxHeaderSize,
  type IncomingHttpHeaders,
  type Server,
} from 'node:http';
import type { Socket } from 'node:net';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { gunicornBadRequest, parseGunicornRequestLine } from './gunicorn-request-line';

/**
 * The two places Node answers a request **without ever calling Express**, and what v1 does
 * there instead. Parity finding **N1**.
 *
 * `llhttp` recognises a fixed table of method names. Anything outside it is
 * `HPE_INVALID_METHOD`, raised before a single byte reaches the router, and Node's default
 * reply is a bare `HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n`. `CONNECT` is
 * inside the table but is routed to the server's `connect` event rather than to the request
 * listener — and with no `connect` listener Node **destroys the socket without replying at
 * all**. Measured: v2 sent *nothing* for `CONNECT /api/loan`, `/api/user` and
 * `/api/activity/year` alike. A response a client cannot read is worse than a wrong one.
 *
 * gunicorn 19.9.0 has no such table. It validates the request *line*
 * ({@link parseGunicornRequestLine}) and hands everything that survives to Django, where the
 * method is just a key: `APIRolePermission` finds no entry for `FROB`, so the answer is the
 * ordinary **403** — and **401** first if the caller is unauthenticated, and **404** first if
 * the URL does not resolve. That is the behaviour this module restores, by feeding the
 * recovered request into the very same Express instance the normal path uses. Nothing is
 * special-cased per route, and no status is synthesised: the guards decide, as they do for
 * `PUT` and `OPTIONS` today.
 *
 * ## What it does not do
 *
 * * It never tunnels a `CONNECT`. The request is dispatched as an ordinary HTTP request with
 *   `req.method === 'CONNECT'`; an authority-form target (`example.com:443`) simply fails to
 *   resolve and is a 404, which is also what v1 answers.
 * * It leaves every other `clientError` code exactly as Node had it — see
 *   {@link writeNodeDefaultClientError}.
 * * It does not port gunicorn's `limit_request_line` / `limit_request_field_size` limits;
 *   those apply to *every* method in v1 and are a pre-existing, method-independent gap.
 */

/** Express's app object is itself the `(req, res)` listener Node would have called. */
type RequestListener = (request: IncomingMessage, response: ServerResponse) => void;

/** `\r\n\r\n` — the end of the header block. */
const HEADER_TERMINATOR = Buffer.from('\r\n\r\n', 'latin1');

/**
 * Node's own `clientError` replies, copied because registering a listener **replaces** them:
 * `socketOnError` only falls back to writing these when `server.emit('clientError', …)`
 * returns `false`, i.e. when nothing is listening. Both strings were measured from a stock
 * `http.createServer()` on Node 24.20.0 — 400 for every parser error, 431 for a header block
 * over `maxHeaderSize`.
 */
const NODE_BAD_REQUEST = Buffer.from(
  'HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n',
  'ascii',
);
const NODE_HEADER_FIELDS_TOO_LARGE = Buffer.from(
  'HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n',
  'ascii',
);

/** Set on a server that has already been wired, so a double `init()` cannot double-reply. */
const INSTALLED = Symbol.for('fondo.gunicornHttpEdge.installed');

/**
 * Sockets this module has taken over.
 *
 * `llhttp` re-raises `HPE_INVALID_METHOD` for **every** further chunk on a socket it has
 * already failed on, and the same chunk is *also* delivered to a `data` listener — measured.
 * Without this set a request split across two TCP segments would be answered twice.
 */
const owned = new WeakSet<Socket>();

/**
 * Wires {@link Server.on} `'clientError'` and `'connect'` on a server that is already
 * serving `dispatch`. Idempotent.
 */
export function installGunicornHttpEdge(server: Server, dispatch: RequestListener): void {
  const marked = server as Server & { [INSTALLED]?: boolean };
  if (marked[INSTALLED] === true) {
    return;
  }
  marked[INSTALLED] = true;

  server.on('clientError', (error: NodeJS.ErrnoException, socket: Socket) => {
    if (owned.has(socket)) {
      return;
    }
    if (error.code !== 'HPE_INVALID_METHOD') {
      writeNodeDefaultClientError(error, socket);
      return;
    }
    owned.add(socket);
    recoverInvalidMethod(server, socket, rawPacketOf(error), dispatch);
  });

  server.on('connect', (request: IncomingMessage, socket: Socket, head: Buffer) => {
    if (owned.has(socket)) {
      return;
    }
    owned.add(socket);
    if (head.length > 0) {
      request.push(head);
    }
    request.push(null);
    dispatchOnSocket(request, socket, dispatch);
  });
}

/** `err.rawPacket` is present on parser errors and absent on transport ones. */
function rawPacketOf(error: NodeJS.ErrnoException): Buffer {
  const packet = (error as { rawPacket?: unknown }).rawPacket;
  return Buffer.isBuffer(packet) ? packet : Buffer.alloc(0);
}

/**
 * Node's `socketOnError` fallback, for the codes this module does not handle
 * (`HPE_INVALID_HEADER_TOKEN`, `HPE_HEADER_OVERFLOW`, `ECONNRESET`, …).
 *
 * ⚠️ This is not an improvement, deliberately. Registering a `clientError` listener silences
 * Node's default for *all* codes, so anything not reproduced here would become a dropped
 * connection — the very defect N1 is about, moved somewhere else.
 */
function writeNodeDefaultClientError(error: NodeJS.ErrnoException, socket: Socket): void {
  if (socket.writable && socket.bytesWritten === 0) {
    socket.end(
      error.code === 'HPE_HEADER_OVERFLOW' ? NODE_HEADER_FIELDS_TOO_LARGE : NODE_BAD_REQUEST,
    );
    return;
  }
  socket.destroy(error);
}

/**
 * Collects the header block `llhttp` refused to parse and answers the way gunicorn would.
 *
 * The parser stops at the first byte of the method, so `err.rawPacket` may hold only a
 * fragment. The socket is still open and still delivering data at this point (measured), so
 * the remainder is read here until the terminator arrives, `maxHeaderSize` is exceeded, or
 * the server's `headersTimeout` elapses. The last two both end the connection with a reply
 * rather than a silent close.
 */
function recoverInvalidMethod(
  server: Server,
  socket: Socket,
  initial: Buffer,
  dispatch: RequestListener,
): void {
  let buffer = initial;
  let settled = false;

  const timeout = setTimeout(() => {
    finish(() => socket.end(NODE_BAD_REQUEST));
  }, server.headersTimeout);
  timeout.unref();

  const onData = (chunk: Buffer): void => {
    buffer = Buffer.concat([buffer, chunk]);
    attempt();
  };
  const onClose = (): void => {
    finish(() => undefined);
  };

  socket.on('data', onData);
  socket.on('close', onClose);
  attempt();

  function finish(act: () => void): void {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timeout);
    socket.removeListener('data', onData);
    socket.removeListener('close', onClose);
    act();
  }

  function attempt(): void {
    if (settled) {
      return;
    }
    const end = buffer.indexOf(HEADER_TERMINATOR);
    if (end < 0) {
      if (buffer.length > maxHeaderSize) {
        finish(() => socket.end(NODE_HEADER_FIELDS_TOO_LARGE));
      }
      return;
    }
    const lines = buffer.subarray(0, end).toString('latin1').split('\r\n');
    const body = buffer.subarray(end + HEADER_TERMINATOR.length);
    const parsed = parseGunicornRequestLine(lines[0]);
    finish(() => {
      if (!parsed.ok) {
        socket.end(gunicornBadRequest(parsed.message));
        return;
      }
      const request = buildIncomingMessage(socket, parsed, lines.slice(1), body);
      dispatchOnSocket(request, socket, dispatch);
    });
  }
}

/**
 * Builds the `IncomingMessage` `llhttp` would have built, from bytes it refused to parse.
 *
 * Header folding (`obs-fold`) is not reconstructed and a line without a colon is dropped —
 * both are already errors in `llhttp` for every *valid* method, so reproducing them here
 * would make an invalid-method request *more* tolerant than a normal one.
 */
function buildIncomingMessage(
  socket: Socket,
  line: { method: string; uri: string; versionMajor: number; versionMinor: number },
  headerLines: string[],
  body: Buffer,
): IncomingMessage {
  const request = new IncomingMessage(socket);
  request.httpVersionMajor = line.versionMajor;
  request.httpVersionMinor = line.versionMinor;
  request.httpVersion = `${line.versionMajor}.${line.versionMinor}`;
  request.method = line.method;
  request.url = line.uri;

  const rawHeaders: string[] = [];
  const headers: IncomingHttpHeaders = {};
  for (const headerLine of headerLines) {
    const separator = headerLine.indexOf(':');
    if (separator <= 0) {
      continue;
    }
    const name = headerLine.slice(0, separator);
    const value = headerLine.slice(separator + 1).trim();
    rawHeaders.push(name, value);
    const key = name.toLowerCase();
    const existing = headers[key];
    headers[key] = typeof existing === 'string' ? `${existing}, ${value}` : value;
  }
  request.headers = headers;
  request.rawHeaders = rawHeaders;

  if (body.length > 0) {
    request.push(body);
  }
  request.push(null);
  request.complete = true;
  return request;
}

/**
 * Runs one already-parsed request through Express on a socket Node has handed back to us.
 *
 * `assignSocket`/`detachSocket` are the same pair Node's own connection listener uses; the
 * socket is closed after the response because these are one-shot requests — the parser is
 * finished with the connection either way, so `shouldKeepAlive` is `false` and the response
 * says `Connection: close`. That is what it *does*, and it is also what v1 says on every
 * response (gunicorn's sync worker — parity note **N2**); the rest of v2 says
 * `keep-alive` because the rest of v2 means it.
 */
function dispatchOnSocket(
  request: IncomingMessage,
  socket: Socket,
  dispatch: RequestListener,
): void {
  const response = new ServerResponse(request);
  response.shouldKeepAlive = false;
  response.assignSocket(socket);
  response.on('finish', () => {
    response.detachSocket(socket);
    socket.end();
  });
  dispatch(request, response);
}

/**
 * Express's own `Route` can match *any* method — `route.all(fn)` sets a `_all` flag that
 * `_handlesMethod` short-circuits on. Express's **application** cannot: `app.all(path, fn)`
 * loops over `http.METHODS` and registers the route once per **known** verb, and Nest's
 * `@All()` goes through `AbstractHttpAdapter.all` → `app.all`. So the `@All()` fallback every
 * controller carries — the one that turns `PUT`, `OPTIONS` and `DELETE` into v1's **403**
 * instead of a 405 or a 404 (plan §4 rule 12) — silently stops at the edge of that table.
 *
 * Until now that was invisible: a token outside `http.METHODS` never reached Express at all,
 * because `llhttp` rejected it first. Recovering those requests makes it visible — measured,
 * `FROB /api/activity/year` reached the resolver (it carries `Allow` and `Vary`) and then fell
 * through the router to Nest's `Cannot FROB /api/activity/year`, a **404** where v1 answers
 * **401/403**.
 *
 * This restores the flag `Router#all` would have set, and **only** on routes that already
 * accept every one of `http.METHODS` — i.e. only on routes `app.all` built. A route declared
 * with `@Get()`/`@Post()` is untouched, so no specific route is widened: the sole difference
 * is that a method token Node has never heard of now reaches the same guard as `PUT` does.
 *
 * The flag is defined **non-enumerable** so `Route#_methods()` — which is `Object.keys` and
 * feeds Express's automatic `OPTIONS` responder — cannot start reporting a method called
 * `ALL`.
 */
export function restoreCatchAllRoutes(router: unknown): void {
  if (router === null || (typeof router !== 'object' && typeof router !== 'function')) {
    return;
  }
  const stack: unknown = (router as { stack?: unknown }).stack;
  if (!Array.isArray(stack)) {
    return;
  }
  for (const layer of stack as ExpressLayer[]) {
    if (layer.route === undefined) {
      // A mounted sub-router: same treatment, one level down. A plain middleware has no
      // `stack` and falls straight back out.
      restoreCatchAllRoutes(layer.handle);
      continue;
    }
    if (isCatchAllRoute(layer.route)) {
      collapseToAllLayer(layer.route);
    }
  }
}

/**
 * Recognises a route built by `app.all` — **one handler registered once per verb**.
 *
 * Deliberately structural rather than "does it list all N methods": `app.all` iterates the
 * `methods` package's list, which is a static 35 entries and is *not* `http.METHODS` (46 on
 * Node 24), so counting against either list is a silent mismatch waiting for a dependency
 * bump. Measured on the running app: the `@All()` routes carry 35 method keys and 35 stack
 * layers sharing a single handler; every `@Get()`/`@Post()`/`@Patch()` route carries exactly
 * one. Nest calls `this.route(path)` per decorator, so a controller's `@Get` and its `@All`
 * are two separate `Route` objects and never merge into one stack.
 */
function isCatchAllRoute(route: ExpressRoute): boolean {
  const layers = route.stack;
  if (!Array.isArray(layers) || layers.length < 2) {
    return false;
  }
  const [first] = layers;
  if (!layers.every((layer) => layer.handle === first.handle)) {
    return false;
  }
  // The seven verbs any `@All()` must have covered — a cheap second signal, so a future
  // Express that de-duplicates the stack cannot make this fire on a two-verb route.
  return ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'].every(
    (method) => route.methods[method] === true,
  );
}

/**
 * Turns one `app.all` route into the route `Router#all` would have built.
 *
 * Two edits, because Express gates the method **twice**. `Route#_handlesMethod` decides
 * whether the router enters the route at all, and `methods._all` satisfies that. `Route#
 * dispatch` then walks the route's own stack and skips every layer whose `layer.method` is
 * not the request's — and `app.all` set a *concrete* verb on all 35 of them, so a `FROB`
 * entered the route and matched none of its layers, fell out of the bottom and reached
 * Nest's `Cannot FROB …` 404. That was the measured behaviour with only the flag set.
 *
 * `route.all(fn)` produces exactly one layer with `method === undefined`. Since
 * {@link isCatchAllRoute} has already established that all 35 layers hold the *same* handler
 * reference, keeping the first and dropping its duplicates is that shape, and cannot change
 * what any known method does.
 *
 * `methods` is left alone apart from the non-enumerable flag, so `Route#_methods()` — which
 * is `Object.keys` and feeds Express's automatic `OPTIONS` responder — still reports the same
 * verbs it reported before.
 */
function collapseToAllLayer(route: ExpressRoute): void {
  Object.defineProperty(route.methods, '_all', { value: true, enumerable: false });
  const layers = route.stack;
  if (layers === undefined) {
    return;
  }
  layers[0].method = undefined;
  layers.length = 1;
}

interface ExpressRoute {
  readonly methods: Record<string, boolean>;
  readonly stack?: { readonly handle?: unknown; method?: string }[];
}

interface ExpressLayer {
  readonly route?: ExpressRoute;
  readonly handle?: unknown;
}

/**
 * Installs {@link installGunicornHttpEdge} on whichever server the app is running, for
 * `main.ts` and every e2e suite alike.
 *
 * It is a **provider**, not a line in `main.ts`, for the reason recorded in `AppModule`:
 * anything installed in `main.ts` is invisible to the e2e suites, which is how
 * `app.enableCors()` shipped a 204-for-every-`OPTIONS` past a green build. `HttpAdapterHost`
 * exposes the `http.Server` and the Express instance, and `onApplicationBootstrap` runs after
 * the routes are mounted and before `listen()`.
 */
@Injectable()
export class GunicornHttpEdge implements OnApplicationBootstrap {
  constructor(private readonly adapterHost: HttpAdapterHost) {}

  onApplicationBootstrap(): void {
    const adapter = this.adapterHost.httpAdapter;
    const server: unknown = adapter?.getHttpServer();
    const instance: unknown = adapter?.getInstance();
    if (
      typeof instance !== 'function' ||
      server === null ||
      typeof server !== 'object' ||
      typeof (server as Server).on !== 'function'
    ) {
      return;
    }
    installGunicornHttpEdge(server as Server, instance as RequestListener);
    restoreCatchAllRoutes((instance as { router?: unknown }).router);
  }
}
