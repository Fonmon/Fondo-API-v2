import type { Request } from 'express';
import { PythonKeyError, PythonTypeError } from '../utils/python-obj';
import { setUploadedFiles, type DjangoUploadedFile } from './django-multipart';
import {
  drfRequestDataGet,
  drfRequestDataHas,
  isMultipartInitFailure,
  isNonAsciiBoundaryFailure,
} from './drf-request-data';
import { setParseState } from './drf-request-parsing.middleware';

/**
 * `request.data` resolved without merging — Phase 8 measurement 2. Every row below is a
 * measured v1 outcome from `~/.fondo-parity-harness/p8/oracle-out2.jsonl`; the e2e suite
 * carries the same cases through the whole pipeline.
 */
function part(fieldname: string, content: string, mimetype = 'text/plain'): DjangoUploadedFile {
  return { fieldname, originalname: `${fieldname}.txt`, mimetype, buffer: Buffer.from(content) };
}

function req(body: unknown, files: DjangoUploadedFile[] = []): Request {
  const request = { body, headers: {} } as unknown as Request;
  setUploadedFiles(request, files);
  return request;
}

describe('drfRequestDataHas — `key in request.data`', () => {
  it('finds a form or multipart field', () => {
    expect(drfRequestDataHas(req({ name: 'a' }), 'name')).toBe(true);
    expect(drfRequestDataHas(req({ name: 'a' }), 'file')).toBe(false);
  });

  it('finds a file part that has no field of the same name (the merge v1 reads)', () => {
    expect(drfRequestDataHas(req({}, [part('file', 'x')]), 'file')).toBe(true);
  });

  it('M2-scalar-file: a plain field named `file` is present — v1 then 500s, never 400s', () => {
    expect(drfRequestDataHas(req({ file: 'notafile' }), 'file')).toBe(true);
  });

  it('P-json-list-keys: a JSON list tests membership', () => {
    expect(drfRequestDataHas(req(['name', 'file', 'type']), 'type')).toBe(true);
    expect(drfRequestDataHas(req(['name', 1]), 'type')).toBe(false);
  });

  it('P-json-string-keys: a JSON string tests substring', () => {
    expect(drfRequestDataHas(req('namefiletype'), 'file')).toBe(true);
    expect(drfRequestDataHas(req('namefile'), 'type')).toBe(false);
  });

  it.each([
    ['P-json-null', null, "argument of type 'NoneType' is not iterable"],
    ['P-json-number', 5, "argument of type 'int' is not iterable"],
    ['a float', 1.5, "argument of type 'float' is not iterable"],
    ['a boolean', true, "argument of type 'bool' is not iterable"],
  ])('%s raises TypeError', (_label, body, message) => {
    expect(() => drfRequestDataHas(req(body), 'name')).toThrow(new PythonTypeError(message));
  });
});

describe('drfRequestDataGet — `request.data[key]`, each value from its own source', () => {
  it('returns a field from the body', () => {
    expect(drfRequestDataGet(req({ name: 'New file' }), 'name')).toEqual({
      source: 'field',
      value: 'New file',
    });
  });

  it('M2-scalar-then-file / M2-file-then-scalar: a file part wins over a field of the same name', () => {
    const file = part('file', 'FILEPART');
    expect(drfRequestDataGet(req({ file: 'SCALAR' }, [file]), 'file')).toEqual({
      source: 'file',
      file,
    });
  });

  it('M2-two-file-parts: the LAST part wins (MultiValueDict.__getitem__)', () => {
    const second = part('file', 'SECOND');
    const entry = drfRequestDataGet(req({}, [part('file', 'FIRST'), second]), 'file');
    expect(entry).toEqual({ source: 'file', file: second });
  });

  it('M2-name-scalar-and-file: a `name` file part is returned as a file, never as its filename', () => {
    const entry = drfRequestDataGet(req({ name: 'm2' }, [part('name', 'n')]), 'name');
    expect(entry.source).toBe('file');
  });

  it('raises KeyError for a key in neither source', () => {
    expect(() => drfRequestDataGet(req({}), 'type')).toThrow(PythonKeyError);
  });

  it.each([
    ['a JSON list', ['type'], 'list indices must be integers or slices, not str'],
    ['a JSON string', 'type', 'string indices must be integers'],
  ])('%s raises TypeError on subscript', (_label, body, message) => {
    expect(() => drfRequestDataGet(req(body), 'type')).toThrow(new PythonTypeError(message));
  });
});

describe('isNonAsciiBoundaryFailure — the subset plan §5 D22 decides', () => {
  const withDetail = (detail: string | null): Request => {
    const request = req({});
    setParseState(request, {
      contentType: 'multipart/form-data',
      hasBody: true,
      parseErrorDetail: detail,
      suspiciousOperation: null,
    });
    return request;
  };

  it.each([
    [
      'a non-ASCII boundary (D22)',
      'Multipart form parse error - Invalid boundary in multipart: zzé',
      true,
    ],
    [
      'a replacement character, as latin1 bytes decode',
      'Multipart form parse error - Invalid boundary in multipart: zz�',
      true,
    ],
    [
      'an empty boundary (not D22)',
      'Multipart form parse error - Invalid boundary in multipart: ',
      false,
    ],
    [
      'a trailing space (not D22)',
      'Multipart form parse error - Invalid boundary in multipart: zzz ',
      false,
    ],
    ['bad base64', 'Multipart form parse error - Could not decode base64 data.', false],
    ['no parse error', null, false],
  ])('%s -> %s', (_label, detail, expected) => {
    expect(isNonAsciiBoundaryFailure(withDetail(detail))).toBe(expected);
  });
});

describe('isMultipartInitFailure — which parse failures v1 double-faults on', () => {
  const withDetail = (detail: string | null): Request => {
    const request = req({});
    setParseState(request, {
      contentType: 'multipart/form-data',
      hasBody: true,
      parseErrorDetail: detail,
      suspiciousOperation: null,
    });
    return request;
  };

  it.each([
    ['S1 empty boundary', 'Multipart form parse error - Invalid boundary in multipart: ', true],
    [
      'S2 non-ASCII boundary',
      'Multipart form parse error - Invalid boundary in multipart: zzé',
      true,
    ],
    [
      'S6 bad base64 (mid-stream)',
      'Multipart form parse error - Could not decode base64 data.',
      false,
    ],
    ['S8 malformed JSON', 'JSON parse error - Expecting value: line 1 column 1 (char 0)', false],
    ['no parse error', null, false],
  ])('%s -> %s', (_label, detail, expected) => {
    expect(isMultipartInitFailure(withDetail(detail))).toBe(expected);
  });

  it('is false for a request the parsing middleware never touched (GET)', () => {
    expect(isMultipartInitFailure(req({}))).toBe(false);
  });
});
