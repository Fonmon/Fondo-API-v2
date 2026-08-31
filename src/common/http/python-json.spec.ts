import {
  drfJsonParseErrorDetail,
  formatPythonJsonError,
  pythonJsonLoadsError,
} from './python-json';
import { CPYTHON_JSON_ERRORS } from './python-json.fixture';

/**
 * §5 D18 / review finding S3.
 *
 * `JSONParser.parse` puts `str(exc)` from CPython straight into the response body, so these
 * strings are part of v1's HTTP contract. The fixture is a differential capture against
 * `python:3.9-slim` — see `python-json.fixture.ts` for the harness.
 */
describe('pythonJsonLoadsError — CPython json.loads messages', () => {
  it('reproduces all 412 captured CPython results', () => {
    const mismatches = CPYTHON_JSON_ERRORS.filter(
      ([input, expected]) => pythonJsonLoadsError(input) !== expected,
    ).map(([input, expected]) => ({
      input,
      expected,
      actual: pythonJsonLoadsError(input),
    }));

    expect(mismatches).toEqual([]);
  });

  it('covers every message CPython can produce', () => {
    // A guard on the fixture rather than on the code: if a regenerated corpus stopped
    // reaching one of these branches, the suite above would silently get weaker.
    const messages = new Set(
      CPYTHON_JSON_ERRORS.map(([, expected]) =>
        expected?.replace(/: line \d+ column \d+ \(char \d+\)$/, ''),
      ).filter((message): message is string => message !== undefined),
    );

    expect(messages).toEqual(
      new Set([
        'Expecting value',
        'Expecting property name enclosed in double quotes',
        "Expecting ':' delimiter",
        "Expecting ',' delimiter",
        'Unterminated string starting at',
        'Invalid control character at',
        'Invalid \\escape',
        'Invalid \\uXXXX escape',
        'Extra data',
        'Unexpected UTF-8 BOM (decode using utf-8-sig)',
      ]),
    );
  });

  it('returns null for a document CPython parses', () => {
    expect(pythonJsonLoadsError('{"username": "a", "password": "b"}')).toBeNull();
    expect(pythonJsonLoadsError('  [1, 2, {"a": null}]  ')).toBeNull();
    // CPython accepts these three non-standard literals by default; Node's JSON.parse does not.
    expect(pythonJsonLoadsError('NaN')).toBeNull();
    expect(pythonJsonLoadsError('Infinity')).toBeNull();
    expect(pythonJsonLoadsError('-Infinity')).toBeNull();
  });

  it('counts lines and columns the way JSONDecodeError does', () => {
    // lineno = doc.count('\n', 0, pos) + 1;  colno = pos - doc.rfind('\n', 0, pos)
    expect(pythonJsonLoadsError('\n\n  x')).toBe('Expecting value: line 3 column 3 (char 4)');
    expect(formatPythonJsonError('Expecting value', 0, '')).toBe(
      'Expecting value: line 1 column 1 (char 0)',
    );
  });
});

describe('drfJsonParseErrorDetail — rest_framework/parsers.py:66', () => {
  it("prefixes CPython's message exactly as DRF does", () => {
    expect(drfJsonParseErrorDetail('not json')).toBe(
      'JSON parse error - Expecting value: line 1 column 1 (char 0)',
    );
    expect(drfJsonParseErrorDetail('{"a" 1}')).toBe(
      "JSON parse error - Expecting ':' delimiter: line 1 column 6 (char 5)",
    );
  });
});
