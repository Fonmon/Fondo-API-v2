import { pythonRepr, pythonReprString, pythonStr } from './django-str';

/**
 * Django's `HStoreField.get_prep_value` coercion — `str()` over every value on the way in.
 *
 * These cells moved here from `hstore.codec.spec.ts` when Phase 9 step 6 (stage 2a) deleted
 * the codec. They survived it because the coercion did: the two converted columns still store
 * what `str()` produced, and `encodeJsonbColumn` still applies it, so a number written by v2
 * matches the 720 rows the migration left behind. See `django-str.ts`.
 */
describe('pythonReprString (CPython str.__repr__)', () => {
  it.each([
    ['abc', "'abc'"],
    ["it's", '"it\'s"'],
    ['say "hi"', '\'say "hi"\''],
    ['both \' and "', "'both \\' and \"'"],
    ['a\nb', "'a\\nb'"],
    ['a\tb', "'a\\tb'"],
    ['a\rb', "'a\\rb'"],
    ['back\\slash', "'back\\\\slash'"],
    ['\u0001', "'\\x01'"],
    ['ñ', "'ñ'"],
    ['', "''"],
  ])('pythonReprString(%j) === %j', (input, expected) => {
    expect(pythonReprString(input)).toBe(expected);
  });
});

describe('pythonRepr / pythonStr (Django HStoreField.get_prep_value coercion)', () => {
  it.each([
    [5, '5'],
    [-5, '-5'],
    [0, '0'],
    [true, 'True'],
    [false, 'False'],
    [null, 'None'],
    [[1, 2, 3], '[1, 2, 3]'],
    [[], '[]'],
    [[5], '[5]'],
    [{}, '{}'],
    [{ a: 1, b: null }, "{'a': 1, 'b': None}"],
  ])('pythonRepr(%j) === %j', (input, expected) => {
    expect(pythonRepr(input)).toBe(expected);
  });

  it('str() leaves a top-level string unquoted but repr() quotes it', () => {
    expect(pythonStr('abc')).toBe('abc');
    expect(pythonRepr('abc')).toBe("'abc'");
  });

  it('nests a dict as a Python repr, NOT as JSON', () => {
    // The one line that explains why v1's read path needed the ' -> " repair, and why the
    // step-6 migration had to unwrap `keys` rather than just cast the column.
    expect(pythonStr({ auth: 'x' })).toBe("{'auth': 'x'}");
    expect(pythonStr({ auth: 'x' })).not.toBe('{"auth": "x"}');
  });

  it('renders a list the way `payload["user_ids"]` was stored', () => {
    expect(pythonStr([5])).toBe('[5]');
    expect(pythonStr([2, 4, 3])).toBe('[2, 4, 3]');
  });
});
