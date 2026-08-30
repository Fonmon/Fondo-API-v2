import { DrfException } from '../../common/http/drf.exception';
import { FieldAllowlist } from './field-allowlist';

describe('FieldAllowlist', () => {
  it('permits only listed fields', () => {
    const allowlist = FieldAllowlist.of('first_name', 'last_name');
    expect(allowlist.permits('first_name')).toBe(true);
    expect(allowlist.permits('role')).toBe(false);
  });

  it('defaults to deny for anything nobody listed', () => {
    expect(FieldAllowlist.none().permits('anything')).toBe(false);
    expect(FieldAllowlist.none().rejected(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('reports rejected fields in the order given', () => {
    const allowlist = FieldAllowlist.of('a');
    expect(allowlist.rejected(['c', 'a', 'b'])).toEqual(['c', 'b']);
  });

  it("throws DRF's 403 on any rejected field", () => {
    const allowlist = FieldAllowlist.of('a');
    expect(() => allowlist.assert(['a'])).not.toThrow();
    try {
      allowlist.assert(['a', 'b']);
      throw new Error('expected a 403');
    } catch (error) {
      expect(error).toBeInstanceOf(DrfException);
      const drf = error as DrfException;
      expect(drf.getStatus()).toBe(403);
      // No field name leaks into the body.
      expect(drf.drfBody).toEqual({
        detail: 'You do not have permission to perform this action.',
      });
    }
  });

  it('accepts an empty write', () => {
    expect(() => FieldAllowlist.none().assert([])).not.toThrow();
  });

  it('deduplicates and sorts for diagnostics', () => {
    expect(FieldAllowlist.from(['b', 'a', 'b']).toArray()).toEqual(['a', 'b']);
  });
});
