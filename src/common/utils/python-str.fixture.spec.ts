import { PYTHON_DECIMAL_DIGIT_RANGES, PYTHON_NONPRINTABLE_RANGES } from './python-str.fixture';
import { PYTHON_DIGIT_CLASS, transformDecimalToAscii } from './python-str';

/**
 * The pinned CPython tables, checked rather than described.
 *
 * Major 9: `PYTHON_DECIMAL_DIGIT_RANGES` has two consumers with different preconditions.
 * `PYTHON_DIGIT_CLASS` is order-blind (a character class is a set); `pythonDecimalDigitValue`
 * binary-searches and needs the array globally ascending. A range appended out of order was
 * measured to widen the class alone — 10 code points the fold ignored — with the whole suite
 * green. The ordering was prose in four places and asserted nowhere; these cells assert it.
 */

/** Every violation of the flat-pairs, ascending, non-overlapping shape, as readable strings. */
function shapeViolations(ranges: ReadonlyArray<number>): string[] {
  const out: string[] = [];
  if (ranges.length % 2 !== 0) {
    out.push(`odd length ${ranges.length}`);
  }
  for (let i = 0; i + 1 < ranges.length; i += 2) {
    const lo = ranges[i];
    const hi = ranges[i + 1];
    if (lo > hi) {
      out.push(`pair ${i / 2}: 0x${lo.toString(16)} > 0x${hi.toString(16)}`);
    }
    if (i > 0 && lo <= ranges[i - 1]) {
      out.push(
        `pair ${i / 2} starts at 0x${lo.toString(16)}, not after 0x${ranges[i - 1].toString(16)}`,
      );
    }
  }
  return out;
}

describe('pinned CPython tables', () => {
  it.each([
    ['PYTHON_DECIMAL_DIGIT_RANGES', PYTHON_DECIMAL_DIGIT_RANGES],
    ['PYTHON_NONPRINTABLE_RANGES', PYTHON_NONPRINTABLE_RANGES],
  ])(
    '%s is flat pairs, ascending and non-overlapping (both are binary-searched)',
    (_name, ranges) => {
      expect(shapeViolations(ranges)).toEqual([]);
    },
  );

  it('PYTHON_DIGIT_CLASS and the decimal fold agree on every code point', () => {
    const inClass = new RegExp(`^[${PYTHON_DIGIT_CLASS}]$`, 'u');
    const mismatches: string[] = [];
    for (let cp = 0; cp <= 0x10ffff && mismatches.length < 20; cp += 1) {
      const ch = String.fromCodePoint(cp);
      // Below U+0080 the fold is the identity, so its answer is "is it an ASCII digit".
      const foldSays =
        cp < 0x80 ? cp >= 0x30 && cp <= 0x39 : /^[0-9]$/.test(transformDecimalToAscii(ch));
      if (inClass.test(ch) !== foldSays) {
        mismatches.push(`U+${cp.toString(16).toUpperCase()}`);
      }
    }
    expect(mismatches).toEqual([]);
  }, 30_000);
});
