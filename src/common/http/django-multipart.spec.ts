import { PythonKeyError } from '../utils/python-obj';
import {
  DjangoSuspiciousOperation,
  MultiPartParserError,
  getUploadedFiles,
  parseDjangoMultipart,
  readUploadedFile,
  sanitizeFileName,
  setUploadedFiles,
  validBoundary,
} from './django-multipart';

/**
 * Parity finding **F8**. Every row below was measured against the live v1
 * (`POST /api-token-auth`, which accepts `MultiPartParser` and is zero-write, so the parse
 * result is visible in the serializer's complaint) or produced by running the function
 * itself in the pinned container:
 *
 * ```
 * docker exec fondo-v1-p3 python -c "import cgi; print(bool(cgi.valid_boundary(b'zzz ')))"
 * ```
 *
 * ## What "correct" means here
 *
 * Django's parser is a *scavenging* one — it raises in three places and salvages everything
 * else. busboy, which multer wraps and which v2 used before, is a *strict* one. Those are
 * not two implementations of the same contract, so the tests that matter are the malformed
 * bodies: the well-formed case agreed all along.
 */
describe('django.http.multipartparser.MultiPartParser', () => {
  const CT = 'multipart/form-data; boundary=zzz';

  const body = (...lines: string[]): Buffer => Buffer.from(lines.join('\r\n'), 'utf8');

  const wellFormed = body(
    '--zzz',
    'Content-Disposition: form-data; name="username"',
    '',
    'nobody@example.com',
    '--zzz',
    'Content-Disposition: form-data; name="password"',
    '',
    'wrong',
    '--zzz--',
    '',
  );

  describe('the happy path — the positive control for every cell below', () => {
    it('reads both fields', () => {
      const result = parseDjangoMultipart(CT, wellFormed);
      expect(result.parsed).toBe(true);
      expect([...result.fields]).toEqual([
        ['username', ['nobody@example.com']],
        ['password', ['wrong']],
      ]);
      expect(result.files).toEqual([]);
    });

    it('reads a file part whole, with its field name, filename and content type', () => {
      const upload = body(
        '--zzz',
        'Content-Disposition: form-data; name="file"; filename="finance.tsv"',
        'Content-Type: text/plain',
        '',
        '1001\t1\t2\t3\t4',
        '--zzz--',
        '',
      );
      const result = parseDjangoMultipart(CT, upload);
      expect(result.files).toEqual([
        {
          fieldname: 'file',
          originalname: 'finance.tsv',
          mimetype: 'text/plain',
          buffer: Buffer.from('1001\t1\t2\t3\t4'),
        },
      ]);
      expect([...result.fields]).toEqual([]);
    });

    it('keeps every value of a repeated field, in order (`MultiValueDict.appendlist`)', () => {
      const repeated = body(
        '--zzz',
        'Content-Disposition: form-data; name="x"',
        '',
        'a',
        '--zzz',
        'Content-Disposition: form-data; name="x"',
        '',
        'b',
        '--zzz--',
        '',
      );
      expect(parseDjangoMultipart(CT, repeated).fields.get('x')).toEqual(['a', 'b']);
    });
  });

  describe('the boundary, which is the whole of the 400/500 line', () => {
    it('an absent `boundary` parameter is NOT an error — the view sees empty data', () => {
      // `None.decode()` raises AttributeError, which is not a MultiPartParserError, so DRF
      // never renders a 400. It escapes `Request._parse` *after* that method has assigned
      // `self._full_data = QueryDict()`, and because `Request.data` is a property Python
      // routes the AttributeError to `Request.__getattr__`, which re-enters the property and
      // returns the empty QueryDict. Measured: `POST /api-token-auth` answers the serializer's
      // "This field is required.", and `PATCH /api/user` answers 500 from `obj['file']`.
      const result = parseDjangoMultipart('multipart/form-data', wellFormed);
      expect(result.parsed).toBe(false);
      expect([...result.fields]).toEqual([]);
      expect(result.files).toEqual([]);
    });

    it('an EMPTY `boundary=` is a MultiPartParserError with the boundary in the message', () => {
      // v1: 400 {"detail":"Multipart form parse error - Invalid boundary in multipart: "}.
      // v2 answered a bare 500 here before this port — the sharpest row of F8.
      expect(() => parseDjangoMultipart('multipart/form-data; boundary=', wellFormed)).toThrow(
        new MultiPartParserError('Invalid boundary in multipart: '),
      );
    });

    it('a boundary failing `cgi.valid_boundary` is the same error', () => {
      expect(() =>
        parseDjangoMultipart('multipart/form-data; boundary="zzz "', wellFormed),
      ).toThrow(new MultiPartParserError('Invalid boundary in multipart: zzz '));
      expect(() =>
        parseDjangoMultipart(`multipart/form-data; boundary=${'a'.repeat(202)}`, wellFormed),
      ).toThrow(new MultiPartParserError(`Invalid boundary in multipart: ${'a'.repeat(202)}`));
    });

    it('a non-multipart content type is `Invalid Content-Type` (DRF never selects it)', () => {
      expect(() => parseDjangoMultipart('application/json', wellFormed)).toThrow(
        new MultiPartParserError('Invalid Content-Type: application/json'),
      );
    });
  });

  describe('what Django salvages rather than rejecting — busboy 400ed on all four', () => {
    it('a body that is not multipart at all yields empty data, not a parse error', () => {
      const result = parseDjangoMultipart(CT, Buffer.from('garbage not multipart at all\n'));
      expect(result.parsed).toBe(true);
      expect([...result.fields]).toEqual([]);
    });

    it('a part truncated mid-stream still yields the field it did read', () => {
      // v1: 400 {"password":["This field is required."]} — username *was* read.
      const truncated = body(
        '--zzz',
        'Content-Disposition: form-data; name="username"',
        '',
        'nobody@example.com',
        '',
      );
      // Verbatim from the oracle: `{'username': ['nobody@example.com\r\n']}` — the trailing
      // CRLF survives because there is no boundary after it to back up over.
      expect(parseDjangoMultipart(CT, truncated).fields.get('username')).toEqual([
        'nobody@example.com\r\n',
      ]);
    });

    it('a body whose boundary does not match the header becomes ONE part, header and all', () => {
      // No separator in the stream, so `BoundaryIter` yields the whole body; its first
      // `\r\n\r\n` is treated as the end of the part header. v1 reads `username` out of it.
      const result = parseDjangoMultipart('multipart/form-data; boundary=www', wellFormed);
      expect(result.fields.get('username')).toEqual([
        'nobody@example.com\r\n--zzz\r\nContent-Disposition: form-data; name="password"' +
          '\r\n\r\nwrong\r\n--zzz--\r\n',
      ]);
      expect(result.fields.get('password')).toBeUndefined();
    });

    it('a part with no `Content-Disposition` is skipped (RAW), not an error', () => {
      const noDisposition = body('--zzz', '', 'no disposition', '--zzz--', '');
      expect([...parseDjangoMultipart(CT, noDisposition).fields]).toEqual([]);
    });

    it('a missing final CRLF changes nothing', () => {
      const noFinalCrlf = Buffer.from(
        '--zzz\r\nContent-Disposition: form-data; name="username"\r\n\r\nnobody\r\n--zzz--',
      );
      expect(parseDjangoMultipart(CT, noFinalCrlf).fields.get('username')).toEqual(['nobody']);
    });

    it('an empty body is an empty QueryDict (`content_length == 0`)', () => {
      const result = parseDjangoMultipart(CT, Buffer.alloc(0));
      expect(result.parsed).toBe(true);
      expect([...result.fields]).toEqual([]);
    });

    it('a part header further than 1 KiB in is RAW, however well-formed the part is', () => {
      const padded = Buffer.concat([
        Buffer.from(`--zzz\r\nX-Pad: ${'p'.repeat(1100)}\r\n`),
        Buffer.from('Content-Disposition: form-data; name="username"\r\n\r\nnobody\r\n--zzz--\r\n'),
      ]);
      expect([...parseDjangoMultipart(CT, padded).fields]).toEqual([]);
    });

    it('a `filename=""` part is a FIELD, not a FILE', () => {
      const emptyFilename = body(
        '--zzz',
        'Content-Disposition: form-data; name="f"; filename=""',
        '',
        'content',
        '--zzz--',
        '',
      );
      const result = parseDjangoMultipart(CT, emptyFilename);
      expect(result.files).toEqual([]);
      expect(result.fields.get('f')).toEqual(['content']);
    });
  });

  describe("Django's two `SuspiciousOperation` limits, which it answers with a 400", () => {
    const fields = (count: number): Buffer =>
      Buffer.concat([
        ...Array.from({ length: count }, (_unused, index) =>
          Buffer.from(`--zzz\r\nContent-Disposition: form-data; name="k${index}"\r\n\r\nv\r\n`),
        ),
        Buffer.from('--zzz--\r\n'),
      ]);

    it('accepts exactly DATA_UPLOAD_MAX_NUMBER_FIELDS fields — the positive control', () => {
      expect(parseDjangoMultipart(CT, fields(1000)).fields.size).toBe(1000);
    });

    it('rejects one more', () => {
      expect(() => parseDjangoMultipart(CT, fields(1001))).toThrow(DjangoSuspiciousOperation);
    });

    it('accepts a 2 MiB field and rejects a 2.5 MiB + one', () => {
      const field = (size: number): Buffer =>
        Buffer.concat([
          Buffer.from('--zzz\r\nContent-Disposition: form-data; name="username"\r\n\r\n'),
          Buffer.alloc(size, 0x78),
          Buffer.from('\r\n--zzz--\r\n'),
        ]);
      expect(parseDjangoMultipart(CT, field(2 * 1024 * 1024)).fields.size).toBe(1);
      expect(() => parseDjangoMultipart(CT, field(2.5 * 1024 * 1024 + 1))).toThrow(
        DjangoSuspiciousOperation,
      );
    });
  });

  describe('cgi.valid_boundary', () => {
    const cases: ReadonlyArray<readonly [string, boolean]> = [
      ['zzz', true],
      ['zzz ', false],
      ['a\tb', false],
      ['a'.repeat(201), true],
      ['a'.repeat(202), false],
      ['', false],
      // `re.match`'s `$` also matches immediately before a trailing newline.
      ['z\n', true],
      ['zz\n', true],
    ];

    it.each(cases)('%p -> %p', (value, expected) => {
      expect(validBoundary(Buffer.from(value, 'latin1'))).toBe(expected);
    });
  });

  describe('sanitize_file_name', () => {
    it.each([
      ['../../etc/passwd', 'passwd'],
      ['C:\\path\\to\\f.tsv', 'f.tsv'],
      ['&amp;.txt', '&.txt'],
      ['&#65;.txt', 'A.txt'],
    ])('%p -> %p', (value, expected) => {
      expect(sanitizeFileName(value)).toBe(expected);
    });

    it.each(['', '.', '..', 'a/..'])('%p is dropped', (value) => {
      expect(sanitizeFileName(value)).toBeNull();
    });
  });

  describe('the request-scoped FILES accessor', () => {
    it('reads back what was written, and is empty on an untouched request', () => {
      const request = {};
      expect(getUploadedFiles(request)).toEqual([]);
      const files = [
        { fieldname: 'file', originalname: 'a', mimetype: '', buffer: Buffer.from('x') },
      ];
      setUploadedFiles(request, files);
      expect(getUploadedFiles(request)).toEqual(files);
    });
  });

  /**
   * `readUploadedFile` was exported from `src/users/user.controller.ts` through Phase 3 and
   * moved here by review condition **C36** — Phase 4's `LoanView.patch` and Phase 8's
   * `FileView.post` need it, and importing it out of the users module is how a second copy
   * (and with it DRF's `FILES`-into-`data` merge, deviation D23) gets written instead.
   */
  describe("readUploadedFile — `request.data['file']`, i.e. `request.FILES`", () => {
    const withFiles = (fieldnames: readonly string[]): object => {
      const request = {};
      setUploadedFiles(
        request,
        fieldnames.map((fieldname) => ({
          fieldname,
          originalname: `${fieldname}.tsv`,
          mimetype: 'text/plain',
          buffer: Buffer.from(`contents of ${fieldname}`),
        })),
      );
      return request;
    };

    it('returns the buffer of the part with that field name', () => {
      expect(readUploadedFile(withFiles(['file']), 'file').toString()).toBe('contents of file');
    });

    it('ignores parts with a different field name', () => {
      expect(readUploadedFile(withFiles(['other', 'file']), 'file').toString()).toBe(
        'contents of file',
      );
    });

    it('takes the FIRST part when a field name repeats', () => {
      const request = {};
      setUploadedFiles(request, [
        { fieldname: 'file', originalname: 'a', mimetype: '', buffer: Buffer.from('first') },
        { fieldname: 'file', originalname: 'b', mimetype: '', buffer: Buffer.from('second') },
      ]);
      expect(readUploadedFile(request, 'file').toString()).toBe('first');
    });

    it('raises KeyError — a 500, not a 400 — when the part is missing', () => {
      expect(() => readUploadedFile(withFiles(['other']), 'file')).toThrow(PythonKeyError);
      expect(() => readUploadedFile(withFiles(['other']), 'file')).toThrow("KeyError: 'file'");
    });

    it('raises KeyError on a request that carried no multipart body at all', () => {
      // The measured v1 status for `PATCH /api/user` with a JSON body: 500, not 415.
      expect(() => readUploadedFile({}, 'file')).toThrow("KeyError: 'file'");
    });
  });
});
