import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { Role } from '../src/auth/permissions/roles';
import { NEST_APPLICATION_OPTIONS } from '../src/bootstrap';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { utcMillisFromParts } from '../src/common/utils/date.util';
import { FILE_STORAGE } from '../src/files/file-storage';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  ADMIN_EMAIL,
  authHeader,
  obtainToken,
  resetDatabase,
  seedAdminUser,
  seedUser,
} from './support/abstract-test';
import { RecordingFileStorage } from './support/recording-file-storage';

/**
 * Phase 8 e2e — `GET|POST /api/file`, `GET /api/file/<id>`, DB-backed, through `AppModule`,
 * with GCS replaced by {@link RecordingFileStorage}.
 *
 * ## Ported from v1
 *
 * `fondo_api/tests/test_file_views.py` — all **8** methods, under their own names in the first
 * `describe`. Its counts (25 files, 15 of type 0) come from v1's **migrations**
 * (`0012_auto_20200223_1516` inserts 15 "Acta número N", `0019_auto_20220313_1225` inserts 10
 * "Resultados YYYY"), which Django's test runner applies to its test database. v2's baseline
 * carries no data, so {@link seedMigrationFiles} inserts the same 25 rows. `fondodev` has 37
 * (23 / 14, measured 2026-09-12) and no cell here uses those numbers.
 *
 * ## Everything else is measured
 *
 * Every other cell names the case in the pinned-v1 oracle it reproduces —
 * `~/.fondo-parity-harness/p8/oracle-out2.jsonl` (in-process, 90 cases, reproduced byte for
 * byte across two runs on an in-place-reset clone) and the gunicorn shape probe
 * (`S1`–`S12`). Where a cell asserts a storage-call sequence, it is v1's sequence for the same
 * request, in the same tuple format.
 */
describe('Phase 8 — /api/file', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const storage = new RecordingFileStorage();
  let adminToken: string;
  let memberToken: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      // v1's tests patch `google.cloud.storage.Client.get_bucket`; this is the same seam.
      .overrideProvider(FILE_STORAGE)
      .useValue(storage)
      .compile();

    app = moduleFixture.createNestApplication(NEST_APPLICATION_OPTIONS);
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);
    // The view logs every caught exception and the filter logs every uncaught one; both are
    // asserted where they matter and silenced otherwise.
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    storage.reset();
    // `AbstractTest.create_user()` + `get_token('mail_for_tests@mail.com', 'password')`.
    await seedAdminUser(prisma);
    await seedUser(prisma, { email: 'member@mail.com', identification: 3003n, role: Role.MEMBER });
    adminToken = await obtainToken(app, ADMIN_EMAIL);
    memberToken = await obtainToken(app, 'member@mail.com');
    await seedMigrationFiles(prisma);
  });

  const server = (): App => app.getHttpServer();
  const asAdmin = (): Record<string, string> => authHeader(adminToken);
  const rows = async (): Promise<{ id: number; type: number; display_name: string }[]> =>
    prisma.file.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, type: true, display_name: true },
    });

  type Part = readonly [name: string, value: string, filename?: string, contentType?: string];
  const FILE_PART: Part = ['file', 'PDFBYTES', 'a.pdf', 'application/pdf'];
  /** Plan §5 D46's body, as bytes. */
  const D46_BODY = '{"message":"A file with this name already exists with a different type"}';
  /** Plan §5 D47's body, as bytes. */
  const D47_BODY = '{"message":"Type must be 0 or 1"}';

  /** The oracle's `mp()`: parts in order, CRLF, boundary `zzz`. */
  const multipart = (parts: readonly Part[], boundary = 'zzz'): Buffer => {
    let out = '';
    for (const [name, value, filename, contentType] of parts) {
      out += `--${boundary}\r\nContent-Disposition: form-data; name="${name}"`;
      if (filename !== undefined) {
        out += `; filename="${filename}"`;
      }
      out += '\r\n';
      if (contentType !== undefined) {
        out += `Content-Type: ${contentType}\r\n`;
      }
      out += `\r\n${value}\r\n`;
    }
    return Buffer.from(`${out}--${boundary}--\r\n`, 'utf8');
  };

  const postMultipart = (parts: readonly Part[], headers = asAdmin()): request.Test =>
    request(server())
      .post('/api/file')
      .set(headers)
      .set('Content-Type', 'multipart/form-data; boundary=zzz')
      .send(multipart(parts));

  const postRaw = (contentType: string, body: string | Buffer): request.Test =>
    request(server()).post('/api/file').set(asAdmin()).set('Content-Type', contentType).send(body);

  /** DRF's `Response(status=...)` from the view: zero bytes, `Allow` and `Vary: Accept` kept. */
  const expectViewResponse = (response: request.Response, status: number): void => {
    expect(response.status).toBe(status);
    expect(response.text).toBe('');
    expect(response.headers.allow).toBe('GET, POST, HEAD, OPTIONS');
    expect(response.headers.vary).toContain('Accept');
  };

  /**
   * A D46 / D47 refusal: the exact `{"message": ...}` bytes, and the view's DRF headers — it is
   * rendered like any `Response({...}, status)` from the view, not like an escaped exception.
   */
  const expectRefusal = (response: request.Response, status: number, body: string): void => {
    expect(response.status).toBe(status);
    expect(response.text).toBe(body);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.headers.allow).toBe('GET, POST, HEAD, OPTIONS');
    expect(response.headers.vary).toContain('Accept');
  };

  /** An exception that escaped the view: v1's page carries neither `Allow` nor `Vary: Accept`. */
  const expectUncaught500 = (response: request.Response): void => {
    expect(response.status).toBe(500);
    expect(response.headers.allow).toBeUndefined();
    expect(response.headers.vary ?? '').not.toContain('Accept');
  };

  // ==========================================================================
  // fondo_api/tests/test_file_views.py — the 8 v1 methods
  // ==========================================================================

  describe('ported from test_file_views.py', () => {
    it('test_post_file_bad_request', async () => {
      const response = await request(server())
        .post('/api/file')
        .set(asAdmin())
        .send({ name: 'New file', type: 'proceeding' });
      expect(response.status).toBe(400);
    });

    it('test_post_file_exception', async () => {
      storage.failures.add('upload');
      const response = await postMultipart([['name', 'New file'], FILE_PART, ['type', '0']]);
      expect(response.status).toBe(500);
    });

    it('test_post_file', async () => {
      expect(await prisma.file.count()).toBe(25);
      const response = await postMultipart([['name', 'New file'], FILE_PART, ['type', '0']]);
      expect(response.status).toBe(201);
      expect(await prisma.file.count()).toBe(26);
    });

    it('test_post_file_already_in_db', async () => {
      storage.objects.set('proceeding/new file', { data: 'old', contentType: 'application/pdf' });
      expect(await prisma.file.count()).toBe(25);
      const response = await postMultipart([['name', 'New file'], FILE_PART, ['type', '0']]);
      expect(response.status).toBe(201);
      expect(await prisma.file.count()).toBe(25);
    });

    it('test_get_url_not_found', async () => {
      const response = await request(server()).get('/api/file/0').set(asAdmin());
      expect(response.status).toBe(404);
    });

    it('test_get_url', async () => {
      const [file] = await rows();
      storage.signedUrl = () => 'This is a URL';
      const response = await request(server()).get(`/api/file/${file.id}`).set(asAdmin());
      expect(response.status).toBe(200);
      expect((response.body as { url: string }).url).toBe('This is a URL');
    });

    it('test_get_files_by_type', async () => {
      const response = await request(server()).get('/api/file?type=0').set(asAdmin());
      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(15);
    });

    it('test_get_files_not_type', async () => {
      const response = await request(server()).get('/api/file').set(asAdmin());
      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(25);
    });
  });

  // ==========================================================================
  // Measurement 1 — the unconditional upload
  // ==========================================================================

  describe('measurement 1 — upload always, row only when the object was new', () => {
    it('M1-new: 201 bodiless; get_bucket → blob → exists → upload; one row', async () => {
      const response = await postMultipart([['name', 'New file'], ['type', '0'], FILE_PART]);
      expectViewResponse(response, 201);
      expect(storage.calls).toEqual([
        ['get_bucket', 'fonmon'],
        ['blob', 'proceeding/new file'],
        ['exists', 'proceeding/new file'],
        ['upload', 'proceeding/new file', 'application/pdf'],
      ]);
      expect((await rows()).slice(25)).toEqual([{ id: 26, type: 0, display_name: 'New file' }]);
    });

    it('M1-again-overwrite: the object is replaced, the row count does not move', async () => {
      await postMultipart([['name', 'New file'], ['type', '0'], FILE_PART]).expect(201);
      storage.calls.length = 0;
      await postMultipart([
        ['name', 'New file'],
        ['type', '0'],
        ['file', 'PDFBYTES-2', 'a.pdf', 'application/pdf'],
      ]).expect(201);
      expect(storage.calls.map((call) => call[0])).toEqual([
        'get_bucket',
        'blob',
        'exists',
        'upload',
      ]);
      expect(storage.objects.get('proceeding/new file')?.data).toBe('PDFBYTES-2');
      expect(await prisma.file.count()).toBe(26);
    });

    it("M1-case-variant-same-path: `NEW FILE` overwrites `New file`'s object; the list keeps the first name", async () => {
      await postMultipart([['name', 'New file'], ['type', '0'], FILE_PART]).expect(201);
      await postMultipart([
        ['name', 'NEW FILE'],
        ['type', '0'],
        ['file', 'PDFBYTES-3', 'a.pdf', 'application/pdf'],
      ]).expect(201);
      expect(storage.objects.get('proceeding/new file')?.data).toBe('PDFBYTES-3');
      expect((await rows()).map((row) => row.display_name)).not.toContain('NEW FILE');
    });

    it.each([
      ['M1-upload-fails', 'upload', ['get_bucket', 'blob', 'exists', 'upload']],
      ['M1-bucket-fails', 'get_bucket', ['get_bucket']],
      ['M1-exists-fails', 'exists', ['get_bucket', 'blob', 'exists']],
    ] as const)("%s: the view's 500, no row, no object", async (_label, failure, sequence) => {
      storage.failures.add(failure);
      const response = await postMultipart([['name', 'fails'], ['type', '0'], FILE_PART]);
      expectViewResponse(response, 500);
      expect(storage.calls.map((call) => call[0])).toEqual(sequence);
      expect(await prisma.file.count()).toBe(25);
      expect(storage.objects.size).toBe(0);
    });

    it("logs v1's line for a caught exception", async () => {
      const error = jest.spyOn(Logger.prototype, 'error');
      error.mockClear();
      storage.failures.add('upload');
      await postMultipart([['name', 'x'], ['type', '0'], FILE_PART]).expect(500);
      expect(error).toHaveBeenCalledWith('Exception saving file: error uploading file');
    });
  });

  // ==========================================================================
  // Measurement 2 — presence reads the merged request.data; values never merge
  // ==========================================================================

  describe('measurement 2 — where `name`, `file` and `type` come from', () => {
    it('M2-scalar-file: `file` as a plain field is PRESENT → 500 after exists (a files-only read would 400)', async () => {
      const response = await postMultipart([
        ['name', 'm2 scalar'],
        ['type', '0'],
        ['file', 'notafile'],
      ]);
      expectViewResponse(response, 500);
      expect(storage.calls).toEqual([
        ['get_bucket', 'fonmon'],
        ['blob', 'proceeding/m2 scalar'],
        ['exists', 'proceeding/m2 scalar'],
      ]);
      expect(await prisma.file.count()).toBe(25);
    });

    it('M2-empty-filename: a `file` part with filename="" is a field (Django), so the same 500', async () => {
      const response = await postMultipart([
        ['name', 'm2 emptyfn'],
        ['type', '0'],
        ['file', 'x', '', 'text/plain'],
      ]);
      expectViewResponse(response, 500);
      expect(storage.calls.map((call) => call[0])).toEqual(['get_bucket', 'blob', 'exists']);
    });

    it.each([
      [
        'M2-scalar-then-file',
        [
          ['file', 'SCALAR'],
          ['file', 'FILEPART-A', 'a.txt', 'text/plain'],
        ],
        'FILEPART-A',
      ],
      [
        'M2-file-then-scalar',
        [
          ['file', 'FILEPART-B', 'b.txt', 'text/plain'],
          ['file', 'SCALAR'],
        ],
        'FILEPART-B',
      ],
      [
        'M2-two-file-parts',
        [
          ['file', 'FIRST', '1.txt', 'text/plain'],
          ['file', 'SECOND', '2.txt', 'text/plain'],
        ],
        'SECOND',
      ],
    ] as const)('%s: 201, and the uploaded bytes are %#', async (label, fileParts, uploaded) => {
      const name = label.toLowerCase();
      const response = await postMultipart([['name', name], ['type', '0'], ...fileParts]);
      expectViewResponse(response, 201);
      expect(storage.objects.get(`proceeding/${name}`)).toEqual({
        data: uploaded,
        contentType: 'text/plain',
      });
      expect(await prisma.file.count()).toBe(26);
    });

    it.each([
      [
        'M2-name-as-file',
        [['type', '0'], ['name', 'n', 'n.txt', 'text/plain'], FILE_PART],
        [['get_bucket', 'fonmon']],
      ],
      [
        'M2-name-scalar-and-file',
        [['name', 'm2 name both'], ['type', '0'], ['name', 'n', 'n.txt', 'text/plain'], FILE_PART],
        [['get_bucket', 'fonmon']],
      ],
      [
        'Z-name-part-FILENAME-is-a-cross-type-name: the part is called `Acta número 1` (a type 0 row) and type is 1 — D46 never reads a file as its filename; still 500',
        [['type', '1'], ['name', 'n', 'Acta número 1', 'text/plain'], FILE_PART],
        [['get_bucket', 'fonmon']],
      ],
      [
        'Z-name-file-over-cross-type-name: a `name` part beside a `name` FIELD that exists under the other type — D46 does not read the field; still 500',
        [['type', '1'], ['name', 'Acta número 1'], ['name', 'n', 'n.txt', 'text/plain'], FILE_PART],
        [['get_bucket', 'fonmon']],
      ],
    ] as const)(
      '%s: a file where a scalar is read → 500, never the filename as a value',
      async (_label, parts, calls) => {
        const response = await postMultipart(parts);
        expectViewResponse(response, 500);
        expect(storage.calls).toEqual(calls);
        expect(await prisma.file.count()).toBe(25);
      },
    );

    it.each([
      [
        'M2-type-as-file',
        [['name', 'm2 type file'], ['type', '0', 't.txt', 'text/plain'], FILE_PART],
      ],
      [
        'M2-type-scalar-and-file',
        [['name', 'm2 type both'], ['type', '0'], ['type', '1', 't.txt', 'text/plain'], FILE_PART],
      ],
      [
        'Z-type-file-name-cross (v1 500 before storage; the name exists under type 0)',
        [['name', 'Acta número 1'], ['type', '1', 't.txt', 'text/plain'], FILE_PART],
      ],
    ] as const)(
      '%s: a `type` file part is not the integer 0 or 1 → D47 400 (v1: 500 on int(), before storage)',
      async (_label, parts) => {
        const response = await postMultipart(parts);
        expectRefusal(response, 400, D47_BODY);
        expect(storage.calls).toEqual([]);
        expect(await prisma.file.count()).toBe(25);
      },
    );

    it("M2-repeated-name: a repeated field is QueryDict's LAST value", async () => {
      const response = await postMultipart([
        ['name', 'm2 rep first'],
        ['name', 'M2 Rep Last'],
        ['type', '0'],
        FILE_PART,
      ]);
      expectViewResponse(response, 201);
      expect(storage.calls[1]).toEqual(['blob', 'proceeding/m2 rep last']);
      expect((await rows())[25].display_name).toBe('M2 Rep Last');
    });
  });

  // ==========================================================================
  // Measurement 3 — the cross-type duplicate is a partial write
  // ==========================================================================

  describe('measurement 3 — a name that exists under the other type', () => {
    it('M3-cross-type → D46: v1 stored the object then 500ed (and a retry 201ed with no row); v2 answers 409 with ZERO storage calls, and so does the retry', async () => {
      await postMultipart([['name', 'New file'], ['type', '0'], FILE_PART]).expect(201);
      storage.calls.length = 0;
      const error = jest.spyOn(Logger.prototype, 'error');
      error.mockClear();

      const first = await postMultipart([
        ['name', 'New file'],
        ['type', '1'],
        ['file', 'CROSS', 'c.pdf', 'application/pdf'],
      ]);
      expectRefusal(first, 409, D46_BODY);
      expect(storage.calls).toEqual([]);
      expect(storage.objects.has('presentations/new file')).toBe(false);
      expect(await prisma.file.count()).toBe(26);

      // M3-cross-type-retry: nothing was stored, so the retry is refused the same way.
      const retry = await postMultipart([
        ['name', 'New file'],
        ['type', '1'],
        ['file', 'CROSS-2', 'c.pdf', 'application/pdf'],
      ]);
      expectRefusal(retry, 409, D46_BODY);
      expect(storage.calls).toEqual([]);
      expect(await prisma.file.count()).toBe(26);
      // A refusal is not v1's "Exception saving file".
      expect(error).not.toHaveBeenCalled();
    });

    it.each([
      ['a seeded type 0 row, request type 1', 'Acta número 1', '1'],
      ['a seeded type 1 row, request type 0', 'Resultados 2012', '0'],
    ])('D46 %s: 409, zero storage calls, rows unchanged', async (_label, name, type) => {
      const response = await postMultipart([['name', name], ['type', type], FILE_PART]);
      expectRefusal(response, 409, D46_BODY);
      expect(storage.calls).toEqual([]);
      expect(storage.objects.size).toBe(0);
      expect(await prisma.file.count()).toBe(25);
    });

    it('a MEMBER is refused by the role guard (403) before D46 runs — no 409 leaks which names exist', async () => {
      const response = await postMultipart(
        [['name', 'Acta número 1'], ['type', '1'], FILE_PART],
        authHeader(memberToken),
      );
      expect(response.status).toBe(403);
      expect(storage.calls).toEqual([]);
    });

    it('D46 neighbour — a case variant under the other type is NOT refused: `ACTA NÚMERO 1` as type 1 → 201 and a new row (v1)', async () => {
      const response = await postMultipart([['name', 'ACTA NÚMERO 1'], ['type', '1'], FILE_PART]);
      expectViewResponse(response, 201);
      expect(storage.calls).toEqual([
        ['get_bucket', 'fonmon'],
        ['blob', 'presentations/acta número 1'],
        ['exists', 'presentations/acta número 1'],
        ['upload', 'presentations/acta número 1', 'application/pdf'],
      ]);
      expect((await rows()).slice(25)).toEqual([
        { id: 26, type: 1, display_name: 'ACTA NÚMERO 1' },
      ]);
    });

    it('D46 neighbour — trailing space is a different name: `Acta número 1 ` as type 1 → 201 (exact, not trimmed)', async () => {
      const response = await postMultipart([['name', 'Acta número 1 '], ['type', '1'], FILE_PART]);
      expectViewResponse(response, 201);
      expect(await prisma.file.count()).toBe(26);
    });

    it("X-exact-t1-over-casevariant: v1 overwrote `DUP X`'s object and answered 201 with no orphan; D46's exact predicate refuses it (409) — as decided, registered", async () => {
      await postMultipart([['name', 'Dup X'], ['type', '0'], FILE_PART]).expect(201);
      await postMultipart([
        ['name', 'DUP X'],
        ['type', '1'],
        ['file', 'CV', 'c.pdf', 'application/pdf'],
      ]).expect(201);
      storage.calls.length = 0;
      const response = await postMultipart([
        ['name', 'Dup X'],
        ['type', '1'],
        ['file', 'EXACT', 'e.pdf', 'application/pdf'],
      ]);
      expectRefusal(response, 409, D46_BODY);
      expect(storage.calls).toEqual([]);
      expect(storage.objects.get('presentations/dup x')?.data).toBe('CV');
    });

    it('M3-existing-row-no-blob (Q41, not refused): a row whose object is missing — upload, then the unique violation', async () => {
      const response = await postMultipart([['name', 'Acta número 1'], ['type', '0'], FILE_PART]);
      expectViewResponse(response, 500);
      expect(storage.objects.has('proceeding/acta número 1')).toBe(true);
      expect(await prisma.file.count()).toBe(25);
    });
  });

  // ==========================================================================
  // Measurement 5 — int() on `type`, in the body and in the query
  // ==========================================================================

  describe('measurement 5 — int(), and D47 on top of it', () => {
    it.each([
      ['M5-type-abc (v1 500 before storage)', 'abc'],
      ['M5-type-1.0 (v1 500 before storage)', '1.0'],
      ['M5-type-arabic3 (v1 stored `3/m5`, 201)', ' ٣ '],
      ['M5-type-neg1 (v1 stored `-1/m5`, 201)', '-1'],
      ['M5-type-int4-overflow (v1 stored the object, then 500)', '2147483648'],
      ['I-underscore10 (v1 stored `10/…`, 201: `1_0` is 10)', '1_0'],
      ['I-fullwidth-plus1 (v1 500: not an int() literal)', '＋1'],
      ['I-fs1 (v1 500: U+001C is not int() whitespace)', '\u001c1'],
      ['type 2', '2'],
      ['int4 min - 1', '-2147483649'],
      ['an empty `type` — PRESENT, so past the presence check', ''],
    ])('D47 %s → 400, zero storage calls, no row', async (_label, type) => {
      const response = await postMultipart([['name', 'm5'], ['type', type], FILE_PART]);
      expectRefusal(response, 400, D47_BODY);
      expect(storage.calls).toEqual([]);
      expect(storage.objects.size).toBe(0);
      expect(await prisma.file.count()).toBe(25);
    });

    it.each([
      ['M5-type-underscore', '0_1', 'presentations/m5', 1, 'presentations'],
      ['I-space1', ' 1 ', 'presentations/m5', 1, 'presentations'],
      ['I-fullwidth1', '１', 'presentations/m5', 1, 'presentations'],
      ['I-nbsp1', '\u00a01', 'presentations/m5', 1, 'presentations'],
      ['I-plus0', '+0', 'proceeding/m5', 0, 'proceeding'],
      ['I-minus0', '-0', 'proceeding/m5', 0, 'proceeding'],
    ])(
      'D47 accepts %s (measured on v1 as 201): type %j at %s, row type %i, listed as %s',
      async (_label, raw, path, type, display) => {
        const response = await postMultipart([['name', 'm5'], ['type', raw], FILE_PART]);
        expectViewResponse(response, 201);
        expect(storage.calls[1]).toEqual(['blob', path]);
        const row = (await rows())[25];
        expect(row.type).toBe(type);
        const listed = (await request(server()).get('/api/file').set(asAdmin())).body as {
          id: number;
          type_display: string;
        }[];
        expect(listed.find((file) => file.id === row.id)?.type_display).toBe(display);
      },
    );

    it.each([
      ['G-type-empty', '/api/file?type='],
      ['G-type-bare', '/api/file?type'],
      ['G-type-abc', '/api/file?type=abc'],
      ['G-type-1.0', '/api/file?type=1.0'],
    ])('%s: an UNCAUGHT 500 (int() is outside the try)', async (_label, path) => {
      expectUncaught500(await request(server()).get(path).set(asAdmin()));
    });

    it.each([
      ['G-type-1', '/api/file?type=-1', 25],
      ['G-type-01', '/api/file?type=-01', 25],
      ['G-type-arabic0', '/api/file?type=%D9%A0', 15],
      ['G-type-underscore', '/api/file?type=0_0', 15],
      ['G-type-space', '/api/file?type=%201%20', 10],
      ['G-type-repeat (last wins)', '/api/file?type=0&type=1', 10],
      ['G-type5', '/api/file?type=5', 0],
      ['G-type-huge', '/api/file?type=99999999999999999999', 0],
      ['G-type-int4max+1', '/api/file?type=2147483648', 0],
      ['G-type-int4min-1', '/api/file?type=-2147483649', 0],
    ])('%s: 200 with %i files', async (_label, path, count) => {
      const response = await request(server()).get(path).set(asAdmin());
      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(count);
    });
  });

  // ==========================================================================
  // D46 / D47 — order of checks, and how they meet measurement 2 and JSON bodies
  // ==========================================================================

  describe('D46 / D47 — order of checks and interactions', () => {
    it.each([
      ['P-mp-missing-name, with type=abc', [['type', 'abc'], FILE_PART]],
      [
        'P-mp-missing-file, with type=5',
        [
          ['name', 'x'],
          ['type', '5'],
        ],
      ],
      [
        'P-mp-missing-type, with a name that exists under type 0',
        [['name', 'Acta número 1'], FILE_PART],
      ],
    ] as const)(
      "presence runs first — %s → v1's BODILESS 400, not D47's or D46's body",
      async (_label, parts) => {
        const response = await postMultipart(parts);
        expectViewResponse(response, 400);
        expect(storage.calls).toEqual([]);
      },
    );

    it.each([
      ['abc', 'abc'],
      ['5', '5'],
    ])(
      'D47 runs before D46 — `Acta número 1` (a type 0 row) with type=%s → 400, not 409',
      async (_label, type) => {
        const response = await postMultipart([
          ['name', 'Acta número 1'],
          ['type', type],
          FILE_PART,
        ]);
        expectRefusal(response, 400, D47_BODY);
        expect(storage.calls).toEqual([]);
      },
    );

    it.each([
      ['Z-name-file-type-abc (v1: 500 before storage)', 'abc'],
      ['Z-name-file-type-5 (v1: 500 after get_bucket)', '5'],
    ])('%s — a `name` file part with a bad type → D47 400', async (_label, type) => {
      const response = await postMultipart([
        ['type', type],
        ['name', 'n', 'n.txt', 'text/plain'],
        FILE_PART,
      ]);
      expectRefusal(response, 400, D47_BODY);
      expect(storage.calls).toEqual([]);
    });

    it.each([
      ['P-json-type-list (v1 500 before storage)', '{"name": "n", "type": [0], "file": "x"}'],
      ['Z-json-type-null (v1 500 before storage)', '{"name": "jn", "type": null, "file": "x"}'],
      ['JSON type 2 (v1 500 after exists)', '{"name": "j2", "type": 2, "file": "x"}'],
    ])('%s → D47 400', async (_label, body) => {
      expectRefusal(await postRaw('application/json', body), 400, D47_BODY);
      expect(storage.calls).toEqual([]);
    });

    it.each([
      [
        'Z-json-type-float (int(1.5) is 1)',
        '{"name": "jf", "type": 1.5, "file": "x"}',
        'presentations/jf',
      ],
      [
        'Z-json-type-true (int(True) is 1)',
        '{"name": "jt", "type": true, "file": "x"}',
        'presentations/jt',
      ],
    ])(
      "%s passes D47 and keeps v1's 500 at .content_type, after exists — measured",
      async (_label, body, path) => {
        expectViewResponse(await postRaw('application/json', body), 500);
        expect(storage.calls).toEqual([
          ['get_bucket', 'fonmon'],
          ['blob', path],
          ['exists', path],
        ]);
      },
    );

    it('a JSON body naming a cross-type file → D46 409 (v1: 500 after exists — a JSON body can never upload)', async () => {
      const response = await postRaw(
        'application/json',
        '{"name": "Acta número 1", "type": 1, "file": "x"}',
      );
      expectRefusal(response, 409, D46_BODY);
      expect(storage.calls).toEqual([]);
    });

    it("N-nul-name: D46 does not query a name holding U+0000 (PostgreSQL would raise 22021) — v1's sequence: upload, then the insert fails, the object stays", async () => {
      const name = 'nul\u0000name';
      expect(name).toHaveLength(8);
      const response = await postMultipart([['name', name], ['type', '0'], FILE_PART]);
      expectViewResponse(response, 500);
      expect(storage.calls).toEqual([
        ['get_bucket', 'fonmon'],
        ['blob', 'proceeding/nul\u0000name'],
        ['exists', 'proceeding/nul\u0000name'],
        ['upload', 'proceeding/nul\u0000name', 'application/pdf'],
      ]);
      expect(storage.objects.has('proceeding/nul\u0000name')).toBe(true);
      expect(await prisma.file.count()).toBe(25);
    });

    it('D46 race — MEASURED: two concurrent uploads of one new name under types 0 and 1 both pass D46; one 201, the other 500s AFTER its upload and leaves an orphan', async () => {
      // Hold every upload until both requests have reached it, so both D46 checks ran against
      // an empty table. The timeout releases a lone request so a regression fails, not hangs.
      let arrived = 0;
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const timeout = setTimeout(() => release(), 5000);
      storage.beforeUpload = async () => {
        arrived += 1;
        if (arrived === 2) {
          release();
        }
        await gate;
      };

      const [asProceeding, asPresentation] = await Promise.all([
        postMultipart([['name', 'Race'], ['type', '0'], FILE_PART]),
        postMultipart([['name', 'Race'], ['type', '1'], FILE_PART]),
      ]);
      clearTimeout(timeout);

      // Both passed D46: the check-then-act window exists.
      expect(arrived).toBe(2);
      expect([asProceeding.status, asPresentation.status].sort()).toEqual([201, 500]);
      const raced = (await rows()).filter((row) => row.display_name === 'Race');
      expect(raced).toHaveLength(1);
      // The unique index kept the table consistent, but not the bucket: both objects exist.
      expect(storage.objects.has('proceeding/race')).toBe(true);
      expect(storage.objects.has('presentations/race')).toBe(true);
      const winner = raced[0].type === 0 ? asProceeding : asPresentation;
      expect(winner.status).toBe(201);

      // Positive control: once the winner's row exists, the same upload is refused (D46).
      storage.beforeUpload = () => Promise.resolve();
      storage.calls.length = 0;
      const again = await postMultipart([
        ['name', 'Race'],
        ['type', raced[0].type === 0 ? '1' : '0'],
        FILE_PART,
      ]);
      expectRefusal(again, 409, D46_BODY);
      expect(storage.calls).toEqual([]);
    });
  });

  // ==========================================================================
  // Measurement 6 — list order
  // ==========================================================================

  describe('measurement 6 — ORDER BY created_at, and the v2 tie-break', () => {
    it('renders a bare, unpaginated list of {id, display_name, type_display} in created_at order', async () => {
      const response = await request(server()).get('/api/file/').set(asAdmin());
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
      expect(response.headers.allow).toBe('GET, POST, HEAD, OPTIONS');
      const body = response.body as { id: number; display_name: string; type_display: string }[];
      expect(body.map((file) => file.id)).toEqual(Array.from({ length: 25 }, (_v, i) => i + 1));
      expect(
        response.text.startsWith(
          '[{"id":1,"display_name":"Acta número 1","type_display":"proceeding"},' +
            '{"id":2,"display_name":"Acta número 2","type_display":"proceeding"},',
        ),
      ).toBe(true);
      expect(body[24]).toEqual({
        id: 25,
        display_name: 'Resultados 2021',
        type_display: 'presentations',
      });
    });

    it('orders by created_at, not by id', async () => {
      const early = await prisma.file.create({
        data: {
          type: 0,
          display_name: 'backdated',
          created_at: new Date(utcMillisFromParts(2019, 0, 1)),
        },
        select: { id: true },
      });
      const body = (await request(server()).get('/api/file?type=0').set(asAdmin())).body as {
        id: number;
      }[];
      expect(body[0].id).toBe(early.id);
    });

    it("breaks a created_at tie by id — a v2 choice; v1's order for tied rows is undefined", async () => {
      const tie = new Date(utcMillisFromParts(2024, 1, 6, 17, 11, 24, 954));
      const a = await prisma.file.create({
        data: { type: 7, display_name: 'tie a', created_at: tie },
        select: { id: true },
      });
      const b = await prisma.file.create({
        data: { type: 7, display_name: 'tie b', created_at: tie },
        select: { id: true },
      });
      // A no-op UPDATE writes a new heap tuple for `a` after `b`'s.
      await prisma.$executeRaw`UPDATE fondo_api_file SET display_name = display_name WHERE id = ${a.id}`;

      // Positive control (C67): without the tie-break this database returns heap order, b then a.
      // If this ever reads a then b, the cell below has stopped discriminating.
      const control = await prisma.$queryRaw<{ id: number }[]>`
        SELECT id FROM fondo_api_file WHERE type = 7 ORDER BY created_at`;
      expect(control.map((row) => row.id)).toEqual([b.id, a.id]);

      const body = (await request(server()).get('/api/file?type=7').set(asAdmin())).body as {
        id: number;
      }[];
      expect(body.map((file) => file.id)).toEqual([a.id, b.id]);
    });
  });

  // ==========================================================================
  // Measurement 7 — CPython lower() on the object path
  // ==========================================================================

  describe('measurement 7 — the object path is CPython 3.9 lower()', () => {
    it.each([
      ['M7-sigma-dotted-I', 'ACTA ΟΔΟΣ İ ǅ ẞ', 'proceeding/acta οδος i̇ ǆ ß'],
      ['M7-drift-1C89 (Node toLowerCase: xᲊ ⱟ ꟁ)', 'XᲉ Ⱟ Ꟁ', 'proceeding/xᲉ Ⱟ Ꟁ'],
      ['M7-empty-name', '', 'proceeding/'],
    ])('%s', async (_label, name, path) => {
      await postMultipart([['name', name], ['type', '0'], FILE_PART]).expect(201);
      expect(storage.calls[1]).toEqual(['blob', path]);
      const row = (await rows())[25];
      expect(row.display_name).toBe(name);

      // The signed URL is built from the same lowered path.
      storage.calls.length = 0;
      const detail = await request(server()).get(`/api/file/${row.id}`).set(asAdmin());
      expect(detail.body).toEqual({ url: `signed://${path}` });
      expect(storage.calls).toEqual([
        ['get_bucket', 'fonmon'],
        ['blob', path],
        ['sign', path, 'v4', 300, 'GET'],
      ]);
    });
  });

  // ==========================================================================
  // Body shapes — the parser runs inside the view's try (rule 12b: no narrowing)
  // ==========================================================================

  describe("body shapes — DRF parses lazily, inside FileView.post's try", () => {
    it.each([
      [
        'P-json-missing-file',
        'application/json',
        '{"name": "New file", "type": "proceeding"}',
        400,
      ],
      ['P-json-all-keys', 'application/json', '{"name": "jsonfile", "type": 0, "file": "x"}', 500],
      ['P-json-list-keys', 'application/json', '["name", "file", "type"]', 500],
      ['P-json-list-partial', 'application/json', '["name", "file"]', 400],
      ['P-json-string-keys', 'application/json', '"namefiletype"', 500],
      ['P-json-string-partial', 'application/json', '"namefile"', 400],
      ['P-json-number', 'application/json', '5', 500],
      ['P-json-null', 'application/json', 'null', 500],
      ['P-json-empty-obj', 'application/json', '{}', 400],
      ['P-json-name-number', 'application/json', '{"name": 5, "type": 0, "file": "x"}', 500],
      ["S8 / P-json-malformed (not DRF's 400)", 'application/json', '{', 500],
      ["S3 / P-text-plain (not DRF's 415)", 'text/plain', 'x', 500],
      ['P-form', 'application/x-www-form-urlencoded', 'name=a&file=b&type=0', 500],
      ['P-form-missing', 'application/x-www-form-urlencoded', 'name=a&type=0', 400],
    ])("%s → %i, the view's own response", async (_label, contentType, body, status) => {
      expectViewResponse(await postRaw(contentType, body), status);
      expect(await prisma.file.count()).toBe(25);
    });

    it("P-json-all-keys / P-form reach exists() and stop at .content_type — v1's sequence", async () => {
      await postRaw('application/x-www-form-urlencoded', 'name=a&file=b&type=0').expect(500);
      expect(storage.calls).toEqual([
        ['get_bucket', 'fonmon'],
        ['blob', 'proceeding/a'],
        ['exists', 'proceeding/a'],
      ]);
    });

    it('P-empty-body → 400', async () => {
      const response = await request(server())
        .post('/api/file')
        .set(asAdmin())
        .set('Content-Type', 'multipart/form-data; boundary=zzz');
      expectViewResponse(response, 400);
    });

    it('P-mp-no-boundary → 400 (Django hands the view an empty QueryDict)', async () => {
      expectViewResponse(
        await postRaw('multipart/form-data', multipart([['name', 'nb'], ['type', '0'], FILE_PART])),
        400,
      );
    });

    it.each([
      [
        'P-mp-missing-file',
        [
          ['name', 'mf'],
          ['type', '0'],
        ],
      ],
      ['P-mp-missing-name', [['type', '0'], FILE_PART]],
      ['P-mp-missing-type', [['name', 'mt'], FILE_PART]],
    ] as const)('%s → 400', async (_label, parts) => {
      expectViewResponse(await postMultipart(parts), 400);
      expect(storage.calls).toEqual([]);
    });

    it.each([
      ['S1 / P-mp-empty-boundary', 'multipart/form-data; boundary='],
      ['an invalid ASCII boundary (trailing space)', 'multipart/form-data; boundary="zzz "'],
    ])(
      '%s → 500 WITHOUT Allow/Vary: v1 double-faults past its own except',
      async (_label, contentType) => {
        const response = await postRaw(
          contentType,
          multipart([['name', 'b'], ['type', '0'], FILE_PART]),
        );
        expectUncaught500(response);
        expect(await prisma.file.count()).toBe(25);
        expect(storage.calls).toEqual([]);
      },
    );

    it('S2 / P-mp-nonascii-boundary → 400 parse error: plan §5 D22 decides it (v1 is 500) — flagged', async () => {
      const response = await postRaw(
        'multipart/form-data; boundary=zzé',
        multipart([['name', 'b'], ['type', '0'], FILE_PART]),
      );
      expect(response.status).toBe(400);
      expect((response.body as { detail: string }).detail).toMatch(
        /^Multipart form parse error - Invalid boundary in multipart: zz/,
      );
      expect(response.headers.allow).toBe('GET, POST, HEAD, OPTIONS');
      expect(await prisma.file.count()).toBe(25);
      expect(storage.calls).toEqual([]);
    });

    it("S6 bad base64 in a file part → the view's 500 (raised mid-stream, no double fault)", async () => {
      const body =
        '--zzz\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\n' +
        'Content-Transfer-Encoding: base64\r\n\r\n!!!notbase64\r\n--zzz--\r\n';
      expectViewResponse(await postRaw('multipart/form-data; boundary=zzz', body), 500);
    });

    it.each([
      [
        'S7 1001 multipart fields',
        'multipart/form-data; boundary=zzz',
        multipart(Array.from({ length: 1001 }, (_v, i): Part => [`f${i}`, '1'])),
      ],
      [
        'S5 1001 form fields',
        'application/x-www-form-urlencoded',
        Array.from({ length: 1001 }, (_v, i) => `f${i}=1`).join('&'),
      ],
    ])(
      "%s → the view's 500, not Django's SuspiciousOperation 400",
      async (_label, contentType, body) => {
        expectViewResponse(await postRaw(contentType, body), 500);
      },
    );

    it.each([
      ['CT-absent', ['file', 'X', 'x.pdf'] as Part, ''],
      ['CT-params', ['file', 'X', 'x.txt', 'Text/Plain; charset=utf-8'] as Part, 'text/plain'],
    ])('%s: the upload receives %j', async (label, filePart, contentType) => {
      await postMultipart([['name', label], ['type', '0'], filePart]).expect(201);
      expect(storage.calls[3]).toEqual([
        'upload',
        `proceeding/${label.toLowerCase()}`,
        contentType,
      ]);
    });
  });

  // ==========================================================================
  // GET /api/file/<id>
  // ==========================================================================

  describe('GET /api/file/<id>', () => {
    it('D-hit: 200 {"url": ...}, Allow for FileDetailView', async () => {
      const response = await request(server()).get('/api/file/1').set(asAdmin());
      expect(response.status).toBe(200);
      expect(response.text).toBe('{"url":"signed://proceeding/acta número 1"}');
      expect(response.headers.allow).toBe('GET, HEAD, OPTIONS');
    });

    it('D-leading-zero: /api/file/01 is id 1', async () => {
      const response = await request(server()).get('/api/file/01').set(asAdmin());
      expect(response.body).toEqual({ url: 'signed://proceeding/acta número 1' });
    });

    it.each([
      ['D-miss0', '/api/file/0'],
      ['D-miss-huge', '/api/file/99999999999999999999'],
    ])('%s: a bodiless 404 and no storage call', async (_label, path) => {
      const response = await request(server()).get(path).set(asAdmin());
      expect(response.status).toBe(404);
      expect(response.text).toBe('');
      expect(response.headers.allow).toBe('GET, HEAD, OPTIONS');
      expect(storage.calls).toEqual([]);
    });

    it.each([
      ['D-bucket-fail', 'get_bucket'],
      ['D-sign-fail', 'sign'],
    ] as const)('%s: an UNCAUGHT 500 — only DoesNotExist is caught', async (_label, failure) => {
      storage.failures.add(failure);
      const response = await request(server()).get('/api/file/1').set(asAdmin());
      expect(response.status).toBe(500);
      expect(response.headers.allow).toBeUndefined();
    });
  });

  // ==========================================================================
  // Roles, methods, and the JSON renderer
  // ==========================================================================

  describe('roles and methods (list_permissions: FileView POST 0 / GET 3; FileDetailView GET 3)', () => {
    it('a MEMBER lists and reads a URL, but cannot upload — and a refused upload touches nothing', async () => {
      await request(server()).get('/api/file').set(authHeader(memberToken)).expect(200);
      await request(server()).get('/api/file/1').set(authHeader(memberToken)).expect(200);
      storage.calls.length = 0;
      const refused = await postMultipart(
        [['name', 'x'], ['type', '0'], FILE_PART],
        authHeader(memberToken),
      );
      expect(refused.status).toBe(403);
      expect(storage.calls).toEqual([]);
      expect(await prisma.file.count()).toBe(25);
    });

    it.each(['put', 'patch', 'delete', 'options'] as const)(
      '%s /api/file is 403 for ADMIN (no key in list_permissions)',
      async (method) => {
        await request(server())[method]('/api/file').set(asAdmin()).expect(403);
      },
    );

    it('HEAD /api/file is 403 for ADMIN — measured on v1 (F-head-list): HEAD is not a key either', async () => {
      await request(server()).head('/api/file?type=0').set(asAdmin()).expect(403);
    });

    it('unauthenticated → 401', async () => {
      await request(server()).get('/api/file').expect(401);
      await request(server()).post('/api/file').expect(401);
    });
  });

  describe('JSON rendering of the list', () => {
    it("non-ASCII is emitted raw, compact separators — as DRF's JSONRenderer does", async () => {
      const response = await request(server()).get('/api/file?type=0').set(asAdmin());
      expect(response.text).toContain('"display_name":"Acta número 1"');
    });

    it('⚠️ U+2028/U+2029: v1 ESCAPES them, v2 does not — registered divergence (P8-F4), pinned both sides', async () => {
      await prisma.file.create({
        data: { type: 8, display_name: 'line\u2028sep\u2029para\u00fa', created_at: new Date() },
      });
      const response = await request(server()).get('/api/file?type=8').set(asAdmin());
      // v1, measured (oracle2 G-u2028): DRF replaces both characters with their \u escapes.
      const v1 = '[{"id":26,"display_name":"line\\u2028sep\\u2029paraú","type_display":"8"}]';
      const v2 = '[{"id":26,"display_name":"line\u2028sep\u2029para\u00fa","type_display":"8"}]';
      expect(response.text).toBe(v2);
      expect(JSON.parse(response.text)).toEqual(JSON.parse(v1));
    });
  });
});

/**
 * v1's migrations `0012_auto_20200223_1516` (15 × type 0) and `0019_auto_20220313_1225`
 * (10 × type 1), which Django applies to its test database. `created_at` is `auto_now_add`, so
 * each row gets a later instant than the one before; one millisecond apart here.
 */
async function seedMigrationFiles(prisma: PrismaService): Promise<void> {
  const base = utcMillisFromParts(2020, 1, 23, 20, 16);
  const names: [number, string][] = [
    ...Array.from({ length: 15 }, (_v, i): [number, string] => [0, `Acta número ${i + 1}`]),
    ...Array.from({ length: 10 }, (_v, i): [number, string] => [1, `Resultados ${2012 + i}`]),
  ];
  for (const [index, [type, displayName]] of names.entries()) {
    await prisma.file.create({
      data: { type, display_name: displayName, created_at: new Date(base + index) },
    });
  }
}
