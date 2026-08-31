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

  /**
   * Review finding S5. `rejected([])` is `[]`, so an empty allowlist used to let an empty
   * write through — the silent no-op §5 D1 forbids for the `finance` section.
   */
  describe('fails closed on an empty allowlist', () => {
    it('throws even when nothing is being written', () => {
      expect(() => FieldAllowlist.none().assert([])).toThrow(DrfException);
      expect(() => FieldAllowlist.of().assert([])).toThrow(DrfException);
      expect(() => FieldAllowlist.from([]).assert([])).toThrow(DrfException);
    });

    it('reports emptiness explicitly', () => {
      expect(FieldAllowlist.none().isEmpty()).toBe(true);
      expect(FieldAllowlist.of('a').isEmpty()).toBe(false);
    });

    it('still accepts an empty write against a non-empty allowlist', () => {
      // A PATCH that changes nothing inside a section the caller may write is a no-op, not
      // a violation.
      expect(() => FieldAllowlist.of('a', 'b').assert([])).not.toThrow();
    });
  });

  it('deduplicates and sorts for diagnostics', () => {
    expect(FieldAllowlist.from(['b', 'a', 'b']).toArray()).toEqual(['a', 'b']);
  });
});
