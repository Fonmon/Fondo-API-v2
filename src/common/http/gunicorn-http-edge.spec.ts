import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { installGunicornHttpEdge, restoreCatchAllRoutes } from './gunicorn-http-edge';

/**
 * The HTTP edge, on a real socket.
 *
 * These cells cannot be written against a mock: the whole subject is what Node's parser does
 * **before** a request listener is called, so the request has to go on the wire. The server
 * here is a bare `http.createServer` with a listener that echoes what it was handed — the
 * point is which requests reach it and with what `method`/`url`/`headers`, not what the
 * application answers. `test/http-edge.e2e-spec.ts` covers the second question against the
 * real app.
 */
describe('gunicorn HTTP edge (parity finding N1)', () => {
  let server: Server;
  let seen: { method?: string; url?: string; headers: Record<string, unknown> }[];

  const listener = (request: IncomingMessage, response: ServerResponse): void => {
    seen.push({ method: request.method, url: request.url, headers: { ...request.headers } });
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(`${request.method} ${request.url}`);
  };

  /** Writes `chunks` in order, `40 ms` apart, and resolves with everything written back. */
  async function wire(chunks: string[]): Promise<string> {
    const { port } = server.address() as AddressInfo;
    return new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        void (async () => {
          for (const [index, chunk] of chunks.entries()) {
            if (index > 0) {
              await new Promise((tick) => setTimeout(tick, 40));
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
      socket.on('close', () => resolve(buffer));
      socket.on('error', reject);
    });
  }

  const request = (line: string, headers = 'Host: localhost\r\n'): Promise<string> =>
    wire([`${line}\r\n${headers}Content-Length: 0\r\nConnection: close\r\n\r\n`]);

  beforeEach(async () => {
    seen = [];
    server = createServer(listener);
    installGunicornHttpEdge(server, listener);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  describe('a method token llhttp does not know', () => {
    it('reaches the request listener with the token intact — v2 before: a bare 400', async () => {
      const response = await request('FROB /api/activity/year HTTP/1.1');

      expect(seen).toEqual([
        expect.objectContaining({ method: 'FROB', url: '/api/activity/year' }),
      ]);
      expect(response).toContain('FROB /api/activity/year');
    });

    it('passes the headers through, so authentication can run on it', async () => {
      await request(
        'FROB /api/activity/year HTTP/1.1',
        'Host: localhost\r\nAuthorization: Token abc\r\n',
      );

      expect(seen[0].headers).toMatchObject({
        host: 'localhost',
        authorization: 'Token abc',
      });
    });

    it('uppercases nothing it should not: the token is exactly what was sent', async () => {
      await request('A$C /x HTTP/1.1');

      expect(seen[0].method).toBe('A$C');
    });

    it('recovers a request split across two writes, and answers exactly once', async () => {
      const response = await wire([
        'FROB /api/activity/y',
        'ear HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
      ]);

      expect(seen).toHaveLength(1);
      expect(seen[0].url).toBe('/api/activity/year');
      expect(response.split('HTTP/1.1 ')).toHaveLength(2);
    });

    it('answers gunicorn’s 400 page, not the listener, when the line is rejected', async () => {
      const response = await request('get /api/activity/year HTTP/1.1');

      expect(seen).toEqual([]);
      expect(response).toContain('HTTP/1.1 400 Bad Request\r\n');
      expect(response).toContain('Invalid Method &#x27;Invalid HTTP method: &#x27;get&#x27;&#x27;');
    });

    it('answers 431 rather than buffering forever when the header block never ends', async () => {
      const response = await wire([
        `FROB /x HTTP/1.1\r\nHost: localhost\r\nX: ${'a'.repeat(70_000)}`,
      ]);

      expect(response).toBe(
        'HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n',
      );
    });
  });

  describe('CONNECT', () => {
    it('reaches the request listener — v2 before: no response at all', async () => {
      const response = await request('CONNECT /api/activity/year HTTP/1.1');

      expect(seen).toEqual([
        expect.objectContaining({ method: 'CONNECT', url: '/api/activity/year' }),
      ]);
      expect(response).toContain('HTTP/1.1 200 OK');
    });

    it('is never tunnelled: an authority-form target is just a path', async () => {
      await request('CONNECT example.test:443 HTTP/1.1');

      expect(seen[0].url).toBe('example.test:443');
    });
  });

  describe('every other parser error keeps Node’s own reply', () => {
    it('writes Node’s bare 400 for an invalid header token', async () => {
      const response = await wire(['GET /x HTTP/1.1\r\nHost: localhost\r\nHo st: 1\r\n\r\n']);

      expect(response).toBe('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      expect(seen).toEqual([]);
    });

    it('leaves a well-formed request alone — the control for all of the above', async () => {
      const response = await request('GET /api/activity/year HTTP/1.1');

      expect(seen).toEqual([expect.objectContaining({ method: 'GET', url: '/api/activity/year' })]);
      expect(response).toContain('HTTP/1.1 200 OK');
    });
  });

  it('installs once, however many times it is called', () => {
    installGunicornHttpEdge(server, listener);
    installGunicornHttpEdge(server, listener);

    expect(server.listenerCount('clientError')).toBe(1);
    expect(server.listenerCount('connect')).toBe(1);
  });
});

describe('restoreCatchAllRoutes — Express’s app.all is not Router#all', () => {
  const ALL_VERBS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'trace'];

  /** What `app.all(path, handler)` leaves behind: one layer per known verb, one handler. */
  function catchAllRoute(handler: () => void): {
    methods: Record<string, boolean>;
    stack: { handle: unknown; method?: string }[];
  } {
    return {
      methods: Object.fromEntries(ALL_VERBS.map((verb) => [verb, true])),
      stack: ALL_VERBS.map((verb) => ({ handle: handler, method: verb })),
    };
  }

  it('collapses an app.all route to one method-agnostic layer', () => {
    const handler = (): void => undefined;
    const route = catchAllRoute(handler);

    restoreCatchAllRoutes({ stack: [{ route }] });

    expect(route.stack).toEqual([{ handle: handler, method: undefined }]);
    expect(route.methods._all).toBe(true);
  });

  it('leaves the enumerable method list untouched, so auto-OPTIONS is unchanged', () => {
    const route = catchAllRoute(() => undefined);

    restoreCatchAllRoutes({ stack: [{ route }] });

    expect(Object.keys(route.methods)).toEqual(ALL_VERBS);
  });

  it('does not touch a single-verb route — no specific route is widened', () => {
    const route = { methods: { get: true }, stack: [{ handle: () => undefined, method: 'get' }] };

    restoreCatchAllRoutes({ stack: [{ route }] });

    expect(route.stack).toHaveLength(1);
    expect(route.stack[0].method).toBe('get');
    expect((route.methods as Record<string, boolean>)._all).toBeUndefined();
  });

  it('does not touch a many-verb route whose layers are different handlers', () => {
    const route = {
      methods: Object.fromEntries(ALL_VERBS.map((verb) => [verb, true])),
      stack: ALL_VERBS.map((verb) => ({ handle: () => verb, method: verb })),
    };

    restoreCatchAllRoutes({ stack: [{ route }] });

    expect(route.stack).toHaveLength(ALL_VERBS.length);
  });

  it('does not touch a two-layer route that misses one of the seven verbs', () => {
    const handler = (): void => undefined;
    const route = {
      methods: { get: true, post: true },
      stack: [
        { handle: handler, method: 'get' },
        { handle: handler, method: 'post' },
      ],
    };

    restoreCatchAllRoutes({ stack: [{ route }] });

    expect(route.stack).toHaveLength(2);
  });

  it('descends into a mounted sub-router', () => {
    const handler = (): void => undefined;
    const route = catchAllRoute(handler);

    restoreCatchAllRoutes({ stack: [{ handle: { stack: [{ route }] } }] });

    expect(route.stack).toHaveLength(1);
  });

  it('is inert on anything that is not a router', () => {
    expect(() => restoreCatchAllRoutes(undefined)).not.toThrow();
    expect(() => restoreCatchAllRoutes({ stack: 'not an array' })).not.toThrow();
  });
});
