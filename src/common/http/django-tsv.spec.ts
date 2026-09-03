import { PythonTypeError } from '../utils/python-obj';
import { djangoFileLines, parseMoneyColumn, requireColumn } from './django-tsv';

/**
 * The bulk-upload TSV primitives, hoisted out of `src/users/user.service.ts` by review
 * condition **C36** so that Phase 4's `bulk_update_loans` reuses them rather than growing a
 * second copy of `int(round(float(x), 0))`.
 *
 * The `djangoFileLines` cases below are the ones that lived in `user.service.spec.ts`, moved
 * verbatim; the `requireColumn` / `parseMoneyColumn` cases are new — both functions were
 * module-private before the move and had no direct unit coverage, only the e2e upload cells.
 */
describe('django-tsv', () => {
  describe('djangoFileLines — `File.__iter__`', () => {
    it('splits on \\r\\n, \\r and \\n', () => {
      expect(djangoFileLines(Buffer.from('a\r\nb\nc\rd'))).toEqual(['a', 'b', 'c', 'd']);
    });

    it('does not produce a trailing empty line for a terminated file', () => {
      expect(djangoFileLines(Buffer.from('a\r\nb\r\n'))).toEqual(['a', 'b']);
    });

    it('DOES produce an empty line for a genuine blank one — which v1 then 500s on', () => {
      expect(djangoFileLines(Buffer.from('a\n\nb\n'))).toEqual(['a', '', 'b']);
    });

    it('is empty for an empty file', () => {
      expect(djangoFileLines(Buffer.from(''))).toEqual([]);
    });
  });

  describe('requireColumn — `list.__getitem__`', () => {
    it('returns the column at the index', () => {
      expect(requireColumn(['1', '2', '3'], 1)).toBe('2');
    });

    it('returns an empty column rather than treating it as absent', () => {
      expect(requireColumn(['1', '', '3'], 1)).toBe('');
    });

    it('raises IndexError for a short row — v1 500s and rolls the whole upload back', () => {
      expect(() => requireColumn(['1'], 4)).toThrow(PythonTypeError);
      expect(() => requireColumn(['1'], 4)).toThrow(
        'IndexError: list index out of range (column 4)',
      );
    });
  });

  describe('parseMoneyColumn — `int(round(float(data[i]), 0))`', () => {
    it('reads a whole-peso column as a BigInt', () => {
      expect(parseMoneyColumn(['x', '1000'], 1)).toBe(1000n);
    });

    it('rounds HALF-EVEN, as CPython 3 does — not Math.round', () => {
      // Math.round would answer 1n, 3n and -1n here.
      expect(parseMoneyColumn(['0.5'], 0)).toBe(0n);
      expect(parseMoneyColumn(['2.5'], 0)).toBe(2n);
      expect(parseMoneyColumn(['1.5'], 0)).toBe(2n);
      expect(parseMoneyColumn(['-0.5'], 0)).toBe(0n);
    });

    it('rounds away from the tie normally', () => {
      expect(parseMoneyColumn(['1000.4'], 0)).toBe(1000n);
      expect(parseMoneyColumn(['1000.6'], 0)).toBe(1001n);
    });

    it('accepts surrounding whitespace, as float() does', () => {
      expect(parseMoneyColumn([' 1000 '], 0)).toBe(1000n);
    });

    it('raises ValueError for an empty or non-numeric column', () => {
      expect(() => parseMoneyColumn([''], 0)).toThrow(
        "ValueError: could not convert string to float: ''",
      );
      expect(() => parseMoneyColumn(['abc'], 0)).toThrow(
        "ValueError: could not convert string to float: 'abc'",
      );
    });

    it('raises IndexError, not ValueError, for a missing column', () => {
      expect(() => parseMoneyColumn(['1'], 3)).toThrow(
        'IndexError: list index out of range (column 3)',
      );
    });
  });
});
