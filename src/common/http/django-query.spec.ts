import { lastQueryValue } from './django-query';

/**
 * Moved out of `src/users/user.controller.ts` by review condition **C36**: `LoanView.get`
 * (Phase 4) reads four query parameters through the same `QueryDict` semantics, and a
 * `import { lastQueryValue } from '../users/user.controller'` in a loan controller is how the
 * second copy gets written instead.
 */
describe('django-query — `QueryDict.get`', () => {
  it('returns a single value unchanged', () => {
    expect(lastQueryValue('2')).toBe('2');
  });

  it('returns the LAST value of a repeated key, as QueryDict.__getitem__ does', () => {
    // `?page=1&page=2` is '2' in v1 and ['1','2'] in Express.
    expect(lastQueryValue(['1', '2'])).toBe('2');
  });

  it('distinguishes an absent key from a present-but-empty one', () => {
    // `undefined` takes v1's unpaginated branch; `''` reaches `int('')` and 500s.
    expect(lastQueryValue(undefined)).toBeUndefined();
    expect(lastQueryValue('')).toBe('');
  });

  it('treats an empty array as absent', () => {
    expect(lastQueryValue([])).toBeUndefined();
  });
});
