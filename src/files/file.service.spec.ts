import { RecordingFileStorage } from '../../test/support/recording-file-storage';
import type { DrfRequestDataEntry } from '../common/http/drf-request-data';
import type { DjangoUploadedFile } from '../common/http/django-multipart';
import type { AppConfigService } from '../config/app-config.service';
import type { PrismaService } from '../prisma/prisma.service';
import { FileService, type FileUploadData } from './file.service';

/**
 * `fondo_api/services/file.py`, unit level — Prisma mocked, storage a recording fake.
 *
 * Every storage-call sequence asserted here is the one the pinned v1 made for the same input
 * (`~/.fondo-parity-harness/p8/oracle-out2.jsonl`, case name in each title). v1's own unit
 * coverage of this service is its view tests, ported in `test/file.e2e-spec.ts`.
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

interface Harness {
  service: FileService;
  prisma: { file: { create: jest.Mock; findMany: jest.Mock; findUnique: jest.Mock } };
  storage: RecordingFileStorage;
  /** `data` of the n-th `prisma.file.create` call. */
  created: (index?: number) => CreatedRow;
  /** The first argument of the n-th `prisma.file.findMany` call. */
  queried: (index?: number) => { where?: unknown };
}

function build(options: { createError?: Error; rows?: unknown[]; found?: unknown } = {}): Harness {
  const prisma = {
    file: {
      create: options.createError
        ? jest.fn().mockRejectedValue(options.createError)
        : jest.fn().mockResolvedValue({ id: 48 }),
      findMany: jest.fn().mockResolvedValue(options.rows ?? []),
      findUnique: jest.fn().mockResolvedValue(options.found ?? null),
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

  it('M1-again-overwrite: the object exists → upload STILL runs, no row', async () => {
    const { service, prisma, storage } = build();
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

  it('M1-case-variant-same-path: `NEW FILE` lowers onto the same object — overwrite, no row', async () => {
    const { service, prisma, storage } = build();
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

  it('M3-cross-type: the row insert fails AFTER the upload — the object stays (partial write)', async () => {
    const unique = Object.assign(new Error('Unique constraint failed on display_name'), {
      code: 'P2002',
    });
    const { service, storage } = build({ createError: unique });
    await expect(service.saveFile(upload({ type: field('1') }))).rejects.toBe(unique);
    expect(storage.objects.has('presentations/new file')).toBe(true);
  });

  it('M5-type-int4-overflow: `integer out of range` AFTER the upload — the object stays', async () => {
    const { service, prisma, storage } = build();
    await expect(service.saveFile(upload({ type: field('2147483648') }))).rejects.toThrow(
      'integer out of range',
    );
    expect(storage.objects.has('2147483648/new file')).toBe(true);
    expect(prisma.file.create).not.toHaveBeenCalled();
  });

  it('accepts the int4 bounds themselves', async () => {
    const { service, created } = build();
    await service.saveFile(upload({ type: field('-2147483648'), name: field('lo') }));
    await service.saveFile(upload({ type: field('2147483647'), name: field('hi') }));
    expect([created(0).type, created(1).type]).toEqual([-2147483648, 2147483647]);
  });

  it.each([
    ['M5-type-abc', field('abc')],
    ['M5-type-1.0', field('1.0')],
    ['M2-type-as-file', part('0')],
    ['P-json-type-list', field([0])],
  ])('%s: int() fails before any storage call', async (_label, type) => {
    const { service, prisma, storage } = build();
    await expect(service.saveFile(upload({ type }))).rejects.toThrow();
    expect(storage.calls).toEqual([]);
    expect(prisma.file.create).not.toHaveBeenCalled();
  });

  it.each([
    ['M2-name-as-file', part('n'), "'InMemoryUploadedFile' object has no attribute 'lower'"],
    ['P-json-name-number', field(5), "'int' object has no attribute 'lower'"],
    ['a JSON null name', field(null), "'NoneType' object has no attribute 'lower'"],
  ])('%s: .lower() fails after get_bucket, before blob()', async (_label, name, message) => {
    const { service, storage } = build();
    await expect(service.saveFile(upload({ name }))).rejects.toThrow(message);
    expect(storage.calls).toEqual([['get_bucket', 'fonmon']]);
  });

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
    ['M5-type-arabic3', ' ٣ ', '3/new file', 3],
    ['M5-type-underscore', '0_1', 'presentations/new file', 1],
    ['M5-type-neg1', '-1', '-1/new file', -1],
  ])('%s: int() folds and the unknown type is its own display', async (_label, raw, path, type) => {
    const { service, storage, created } = build();
    await service.saveFile(upload({ type: field(raw) }));
    expect(storage.calls[1]).toEqual(['blob', path]);
    expect(created().type).toBe(type);
  });

  it('JSON numbers and booleans go through int() too (int(1.5) is 1, int(True) is 1)', async () => {
    const { service, storage } = build();
    await service.saveFile(upload({ type: field(1.5), name: field('a') }));
    await service.saveFile(upload({ type: field(true), name: field('b') }));
    expect(storage.calls.filter((call) => call[0] === 'blob')).toEqual([
      ['blob', 'presentations/a'],
      ['blob', 'presentations/b'],
    ]);
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
