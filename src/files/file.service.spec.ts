import { HttpStatus } from '@nestjs/common';
import { RecordingFileStorage } from '../../test/support/recording-file-storage';
import { ApiException } from '../common/http/api.exception';
import type { DrfRequestDataEntry } from '../common/http/drf-request-data';
import type { DjangoUploadedFile } from '../common/http/django-multipart';
import type { AppConfigService } from '../config/app-config.service';
import type { PrismaService } from '../prisma/prisma.service';
import { D46_MESSAGE, D47_MESSAGE, FileService, type FileUploadData } from './file.service';

/**
 * `fondo_api/services/file.py`, unit level — Prisma mocked, storage a recording fake.
 *
 * Every storage-call sequence asserted here is the one the pinned v1 made for the same input
 * (`~/.fondo-parity-harness/p8/oracle-out2.jsonl` and `oracle-d46-out.jsonl`, case name in each
 * title), except where a title names **D46** or **D47** — the two v2 refusals, which make no
 * storage call at all. v1's own unit coverage of this service is its view tests, ported in
 * `test/file.e2e-spec.ts`.
 */
const field = (value: unknown): DrfRequestDataEntry => ({ source: 'field', value });
const part = (content = 'PDFBYTES', mimetype = 'application/pdf'): DrfRequestDataEntry => ({
  source: 'file',
  file: {
    fieldname: 'file',
    originalname: 'a.pdf',
    mimetype,
    buffer: Buffer.from(content),
  } satisfies DjangoUploadedFile,
});

function upload(overrides: Partial<FileUploadData> = {}): FileUploadData {
  return { type: field('0'), name: field('New file'), file: part(), ...overrides };
}

interface CreatedRow {
  type: number;
  display_name: string;
  created_at: Date;
}

interface ExistingRow {
  display_name: string;
  type: number;
}

interface Harness {
  service: FileService;
  prisma: { file: { create: jest.Mock; findMany: jest.Mock; findUnique: jest.Mock } };
  storage: RecordingFileStorage;
  /** `data` of the n-th `prisma.file.create` call. */
  created: (index?: number) => CreatedRow;
  /** The first argument of the n-th `prisma.file.findMany` call. */
  queried: (index?: number) => { where?: unknown };
}

/**
 * `existing` backs `findUnique({ where: { display_name } })` with PostgreSQL `=` semantics on
 * `text` under a deterministic collation: exact, code point for code point. `found` backs
 * `findUnique({ where: { id } })`.
 */
function build(
  options: {
    createError?: Error;
    rows?: unknown[];
    found?: unknown;
    existing?: readonly ExistingRow[];
  } = {},
): Harness {
  const existing = options.existing ?? [];
  const prisma = {
    file: {
      create: options.createError
        ? jest.fn().mockRejectedValue(options.createError)
        : jest.fn().mockResolvedValue({ id: 48 }),
      findMany: jest.fn().mockResolvedValue(options.rows ?? []),
      findUnique: jest.fn((args: { where: { id?: number; display_name?: string } }) => {
        if (args.where.display_name !== undefined) {
          const row = existing.find((r) => r.display_name === args.where.display_name);
          return Promise.resolve(row === undefined ? null : { type: row.type });
        }
        return Promise.resolve(options.found ?? null);
      }),
    },
  };
  const storage = new RecordingFileStorage();
  const config = { gcsBucket: 'fonmon' } as AppConfigService;
  const service = new FileService(prisma as unknown as PrismaService, storage, config);
  const created = (index = 0): CreatedRow =>
    ((prisma.file.create.mock.calls as unknown[][])[index][0] as { data: CreatedRow }).data;
  const queried = (index = 0): { where?: unknown } =>
    (prisma.file.findMany.mock.calls as unknown[][])[index][0] as { where?: unknown };
  return { service, prisma, storage, created, queried };
}

/** The refusal: an `ApiException` with this status and `{message}`, flagged `isDeviation`. */
async function expectRefusal(
  promise: Promise<unknown>,
  status: HttpStatus,
  message: string,
): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ApiException);
  const refusal = error as ApiException;
  expect(refusal.getStatus()).toBe(status);
  expect(refusal.body).toEqual({ message });
  expect(refusal.isDeviation).toBe(true);
}

const unique = (): Error =>
  Object.assign(new Error('Unique constraint failed on display_name'), { code: 'P2002' });

describe('FileService.saveFile (unit)', () => {
  it('M1-new: get_bucket, blob, exists, upload — then the row', async () => {
    const { service, prisma, storage, created } = build();
    await service.saveFile(upload());
    expect(storage.calls).toEqual([
      ['get_bucket', 'fonmon'],
      ['blob', 'proceeding/new file'],
      ['exists', 'proceeding/new file'],
      ['upload', 'proceeding/new file', 'application/pdf'],
    ]);
    expect(prisma.file.create).toHaveBeenCalledTimes(1);
    expect(created().type).toBe(0);
    expect(created().display_name).toBe('New file');
    expect(created().created_at).toBeInstanceOf(Date);
  });

  it('M1-again-overwrite (Q41, not refused by D46): the object exists → upload STILL runs, no row', async () => {
    const { service, prisma, storage } = build({
      existing: [{ display_name: 'New file', type: 0 }],
    });
    storage.objects.set('proceeding/new file', { data: 'old', contentType: 'application/pdf' });
    await service.saveFile(upload({ file: part('PDFBYTES-2') }));
    expect(storage.calls.map((call) => call[0])).toEqual([
      'get_bucket',
      'blob',
      'exists',
      'upload',
    ]);
    expect(storage.objects.get('proceeding/new file')?.data).toBe('PDFBYTES-2');
    expect(prisma.file.create).not.toHaveBeenCalled();
  });

  it('M1-case-variant-same-path (Q41): `NEW FILE` lowers onto the same object — overwrite, no row', async () => {
    const { service, prisma, storage } = build({
      existing: [{ display_name: 'New file', type: 0 }],
    });
    storage.objects.set('proceeding/new file', { data: 'old', contentType: 'application/pdf' });
    await service.saveFile(upload({ name: field('NEW FILE') }));
    expect(storage.calls[1]).toEqual(['blob', 'proceeding/new file']);
    expect(prisma.file.create).not.toHaveBeenCalled();
  });

  it.each([
    ['M1-bucket-fails', 'get_bucket', ['get_bucket']],
    ['M1-exists-fails', 'exists', ['get_bucket', 'blob', 'exists']],
    ['M1-upload-fails', 'upload', ['get_bucket', 'blob', 'exists', 'upload']],
  ] as const)('%s: rejects, stops there, writes no row', async (_label, failure, sequence) => {
    const { service, prisma, storage } = build();
    storage.failures.add(failure);
    await expect(service.saveFile(upload())).rejects.toThrow();
    expect(storage.calls.map((call) => call[0])).toEqual(sequence);
    expect(prisma.file.create).not.toHaveBeenCalled();
    expect(storage.objects.size).toBe(0);
  });

  it('M3-existing-row-no-blob (Q41, not refused): same name, same type, object missing — upload, then the unique violation; the object stays', async () => {
    const error = unique();
    const { service, storage } = build({
      createError: error,
      existing: [{ display_name: 'New file', type: 0 }],
    });
    await expect(service.saveFile(upload())).rejects.toBe(error);
    expect(storage.calls.map((call) => call[0])).toEqual([
      'get_bucket',
      'blob',
      'exists',
      'upload',
    ]);
    expect(storage.objects.has('proceeding/new file')).toBe(true);
  });

  it('D46 window: the check found no row, but the insert still hits the unique index AFTER the upload — the object stays', async () => {
    // What the losing request of two concurrent cross-type uploads sees (e2e measures the race).
    const error = unique();
    const { service, storage } = build({ createError: error });
    await expect(service.saveFile(upload({ type: field('1') }))).rejects.toBe(error);
    expect(storage.objects.has('presentations/new file')).toBe(true);
  });

  it('N-nul-name: a name containing U+0000 is not queried by D46 — upload, then the insert fails, as v1', async () => {
    const error = new Error('invalid byte sequence for encoding "UTF8": 0x00');
    const { service, prisma, storage } = build({ createError: error });
    await expect(service.saveFile(upload({ name: field('nul\u0000name') }))).rejects.toBe(error);
    expect(prisma.file.findUnique).not.toHaveBeenCalled();
    expect(storage.calls).toEqual([
      ['get_bucket', 'fonmon'],
      ['blob', 'proceeding/nul\u0000name'],
      ['exists', 'proceeding/nul\u0000name'],
      ['upload', 'proceeding/nul\u0000name', 'application/pdf'],
    ]);
  });

  it.each([
    ['M2-name-as-file', part('n'), "'InMemoryUploadedFile' object has no attribute 'lower'"],
    ['P-json-name-number', field(5), "'int' object has no attribute 'lower'"],
    ['a JSON null name', field(null), "'NoneType' object has no attribute 'lower'"],
  ])(
    '%s: not queried by D46; .lower() fails after get_bucket, before blob()',
    async (_label, name, message) => {
      const { service, prisma, storage } = build({
        existing: [{ display_name: 'New file', type: 1 }],
      });
      await expect(service.saveFile(upload({ name }))).rejects.toThrow(message);
      expect(prisma.file.findUnique).not.toHaveBeenCalled();
      expect(storage.calls).toEqual([['get_bucket', 'fonmon']]);
    },
  );

  it.each([
    ['M2-scalar-file', field('notafile'), "'str' object has no attribute 'content_type'"],
    ['a JSON dict file', field({ a: 1 }), "'dict' object has no attribute 'content_type'"],
  ])('%s: .content_type fails after exists(), before upload', async (_label, file, message) => {
    const { service, prisma, storage } = build();
    await expect(service.saveFile(upload({ file }))).rejects.toThrow(message);
    expect(storage.calls.map((call) => call[0])).toEqual(['get_bucket', 'blob', 'exists']);
    expect(prisma.file.create).not.toHaveBeenCalled();
  });

  it.each([
    ['M7-sigma-dotted-I', 'ACTA ΟΔΟΣ İ ǅ ẞ', 'proceeding/acta οδος i̇ ǆ ß'],
    ['M7-drift-1C89 (toLowerCase would give ᲊ ⱟ ꟁ)', 'XᲉ Ⱟ Ꟁ', 'proceeding/xᲉ Ⱟ Ꟁ'],
    ['M7-empty-name', '', 'proceeding/'],
  ])(
    '%s: the object path is CPython lower(), the row keeps the name as sent',
    async (_label, name, path) => {
      const { service, storage, created } = build();
      await service.saveFile(upload({ name: field(name) }));
      expect(storage.calls[1]).toEqual(['blob', path]);
      expect(created().display_name).toBe(name);
    },
  );

  it.each([
    ['CT-absent', '', ''],
    ['CT-params', 'text/plain', 'text/plain'],
  ])(
    '%s: the part content type reaches the upload as given',
    async (_label, mimetype, expected) => {
      const { service, storage } = build();
      await service.saveFile(upload({ file: part('X', mimetype) }));
      expect(storage.calls[3]).toEqual(['upload', 'proceeding/new file', expected]);
    },
  );
});

describe('FileService.saveFile — D47, type must be 0 or 1 (unit)', () => {
  it.each([
    ['I-space1', field(' 1 '), 1, 'presentations/new file'],
    ['I-fullwidth1', field('１'), 1, 'presentations/new file'],
    ['I-nbsp1', field('\u00a01'), 1, 'presentations/new file'],
    ['I-plus0', field('+0'), 0, 'proceeding/new file'],
    ['I-minus0', field('-0'), 0, 'proceeding/new file'],
    ['M5-type-underscore', field('0_1'), 1, 'presentations/new file'],
    ['00', field('00'), 0, 'proceeding/new file'],
    ['JSON 0', field(0), 0, 'proceeding/new file'],
    ['JSON 1', field(1), 1, 'presentations/new file'],
    ['JSON false (int(False) is 0)', field(false), 0, 'proceeding/new file'],
    ['Z-json-type-true (int(True) is 1)', field(true), 1, 'presentations/new file'],
    ['Z-json-type-float (int(1.5) is 1)', field(1.5), 1, 'presentations/new file'],
    ['JSON 0.9 (int(0.9) is 0)', field(0.9), 0, 'proceeding/new file'],
  ])('%s: %j accepted, stored as type %i at %s', async (_label, type, stored, path) => {
    const { service, storage, created } = build();
    await service.saveFile(upload({ type }));
    expect(storage.calls[1]).toEqual(['blob', path]);
    expect(created().type).toBe(stored);
  });

  it.each([
    ['M5-type-abc', field('abc')],
    ['M5-type-1.0', field('1.0')],
    ['M5-type-neg1', field('-1')],
    ['M5-type-arabic3', field(' ٣ ')],
    ['I-underscore10 (1_0 is 10)', field('1_0')],
    ['I-fullwidth-plus1', field('＋1')],
    ['I-fs1 (U+001C is not int() whitespace)', field('\u001c1')],
    ['2', field('2')],
    ['M5-type-int4-overflow', field('2147483648')],
    ['int4 min - 1', field('-2147483649')],
    ['int4 max', field('2147483647')],
    ['huge', field('99999999999999999999')],
    ['empty string', field('')],
    ['M2-type-as-file (v1: TypeError 500)', part('0')],
    ['M2-type-as-file whose bytes are "1"', part('1')],
    ['P-json-type-list', field([0])],
    ['Z-json-type-null', field(null)],
    ['JSON object', field({ type: 0 })],
    ['JSON 2', field(2)],
    ['JSON -1', field(-1)],
    ['JSON Infinity-like (not reachable from JSON.parse, but a number)', field(Infinity)],
  ])(
    '%s: 400 Type must be 0 or 1, before D46 and before any storage call',
    async (_label, type) => {
      const { service, prisma, storage } = build();
      await expectRefusal(service.saveFile(upload({ type })), HttpStatus.BAD_REQUEST, D47_MESSAGE);
      expect(storage.calls).toEqual([]);
      expect(prisma.file.findUnique).not.toHaveBeenCalled();
      expect(prisma.file.create).not.toHaveBeenCalled();
    },
  );

  it('D47 runs before D46: an invalid type under a name that exists under another type is 400, not 409', async () => {
    const { service, prisma, storage } = build({
      existing: [{ display_name: 'New file', type: 0 }],
    });
    await expectRefusal(
      service.saveFile(upload({ type: field('5') })),
      HttpStatus.BAD_REQUEST,
      D47_MESSAGE,
    );
    expect(prisma.file.findUnique).not.toHaveBeenCalled();
    expect(storage.calls).toEqual([]);
  });

  it('a type file part with a name file part: D47 answers (400) before .lower() could 500', async () => {
    const { service, storage } = build();
    await expectRefusal(
      service.saveFile(upload({ type: part('0'), name: part('n') })),
      HttpStatus.BAD_REQUEST,
      D47_MESSAGE,
    );
    expect(storage.calls).toEqual([]);
  });
});

describe('FileService.saveFile — D46, a name reused under the other type (unit)', () => {
  it.each([
    ['type 0 row, request type 1', 0, '1'],
    ['type 1 row, request type 0', 1, '0'],
  ])('%s: 409, zero storage calls, no row, no object', async (_label, rowType, requestType) => {
    const { service, prisma, storage } = build({
      existing: [{ display_name: 'New file', type: rowType }],
    });
    await expectRefusal(
      service.saveFile(upload({ type: field(requestType) })),
      HttpStatus.CONFLICT,
      D46_MESSAGE,
    );
    expect(storage.calls).toEqual([]);
    expect(storage.objects.size).toBe(0);
    expect(prisma.file.create).not.toHaveBeenCalled();
  });

  it('compares the name exactly as sent — the query is the untouched display_name', async () => {
    const { service, prisma } = build();
    await service.saveFile(upload({ name: field('  New FILE ') }));
    expect(prisma.file.findUnique).toHaveBeenCalledWith({
      where: { display_name: '  New FILE ' },
      select: { type: true },
    });
  });

  it('compares with the parsed type, not the raw string: `" 1 "` under a type 0 row is refused', async () => {
    const { service } = build({ existing: [{ display_name: 'New file', type: 0 }] });
    await expectRefusal(
      service.saveFile(upload({ type: field(' 1 ') })),
      HttpStatus.CONFLICT,
      D46_MESSAGE,
    );
  });

  it('compares with the parsed type: `"+0"` under a type 0 row is the same type — not refused', async () => {
    const { service, storage } = build({ existing: [{ display_name: 'New file', type: 0 }] });
    await service.saveFile(upload({ type: field('+0') }));
    expect(storage.calls.map((call) => call[0])).toEqual([
      'get_bucket',
      'blob',
      'exists',
      'upload',
    ]);
  });

  it('a case variant under the other type is NOT refused: a new row, as v1', async () => {
    const { service, storage, created } = build({
      existing: [{ display_name: 'New file', type: 0 }],
    });
    await service.saveFile(upload({ name: field('NEW FILE'), type: field('1') }));
    expect(storage.calls[3]).toEqual(['upload', 'presentations/new file', 'application/pdf']);
    expect(created()).toMatchObject({ display_name: 'NEW FILE', type: 1 });
  });

  it('X-exact-t1-over-casevariant: refused even where v1 overwrote without an orphan (the exact predicate, as decided)', async () => {
    const { service, storage } = build({
      existing: [
        { display_name: 'Dup X', type: 0 },
        { display_name: 'DUP X', type: 1 },
      ],
    });
    storage.objects.set('presentations/dup x', { data: 'CV', contentType: 'application/pdf' });
    await expectRefusal(
      service.saveFile(upload({ name: field('Dup X'), type: field('1') })),
      HttpStatus.CONFLICT,
      D46_MESSAGE,
    );
    expect(storage.calls).toEqual([]);
    expect(storage.objects.get('presentations/dup x')?.data).toBe('CV');
  });
});

describe('FileService.getFiles (unit)', () => {
  const rows = [
    { id: 1, type: 0, display_name: 'Acta número 1' },
    { id: 51, type: 3, display_name: 'm5 arabic' },
  ];

  it('-1: every row, ordered by created_at then id (the v2 tie-break)', async () => {
    const { service, prisma } = build({ rows });
    await expect(service.getFiles(-1)).resolves.toEqual([
      { id: 1, display_name: 'Acta número 1', type_display: 'proceeding' },
      { id: 51, display_name: 'm5 arabic', type_display: '3' },
    ]);
    expect(prisma.file.findMany).toHaveBeenCalledWith({
      where: undefined,
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      select: { id: true, type: true, display_name: true },
    });
  });

  it.each([0, 1, 5, -2, -2147483648, 2147483647])('%i: filters by that type', async (type) => {
    const { service, queried } = build();
    await service.getFiles(type);
    expect(queried().where).toEqual({ type });
  });

  it.each([2147483648, -2147483649, 1e20])(
    'G-type-int4max+1 / int4min-1 / huge (%s): [] without a query',
    async (type) => {
      const { service, prisma } = build();
      await expect(service.getFiles(type)).resolves.toEqual([]);
      expect(prisma.file.findMany).not.toHaveBeenCalled();
    },
  );

  it('serialises the three fields in Meta.fields order', async () => {
    const { service } = build({ rows: [rows[0]] });
    const [dto] = await service.getFiles(-1);
    expect(Object.keys(dto)).toEqual(['id', 'display_name', 'type_display']);
  });
});

describe('FileService.getSignedUrl (unit)', () => {
  it('D-miss0: no row → null, and storage is never touched', async () => {
    const { service, storage } = build();
    await expect(service.getSignedUrl(0)).resolves.toBeNull();
    expect(storage.calls).toEqual([]);
  });

  it('D-hit: get_bucket, blob(lowered path), a v4 GET URL for 300 s', async () => {
    const { service, storage } = build({
      found: { id: 1, type: 0, display_name: 'Acta número 1' },
    });
    await expect(service.getSignedUrl(1)).resolves.toEqual({
      url: 'signed://proceeding/acta número 1',
    });
    expect(storage.calls).toEqual([
      ['get_bucket', 'fonmon'],
      ['blob', 'proceeding/acta número 1'],
      ['sign', 'proceeding/acta número 1', 'v4', 300, 'GET'],
    ]);
  });

  it.each(['get_bucket', 'sign'] as const)(
    'D-%s-fail: the storage error propagates',
    async (failure) => {
      const { service, storage } = build({ found: { id: 1, type: 1, display_name: 'X' } });
      storage.failures.add(failure);
      await expect(service.getSignedUrl(1)).rejects.toThrow();
    },
  );
});
