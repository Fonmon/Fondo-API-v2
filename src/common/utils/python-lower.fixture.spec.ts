import {
  PYTHON_CASED_RANGES,
  PYTHON_CASE_IGNORABLE_RANGES,
  PYTHON_LOWER_CONTEXT_FIXTURE,
  PYTHON_LOWER_EXPANSIONS,
  PYTHON_LOWER_SIMPLE,
} from './python-lower.fixture';

/**
 * The shape of the pinned `str.lower()` tables — plan §4 rule **15b**, in the commit that pins
 * them.
 *
 * `python-lower.ts` loads these into a `Map` and two `Set`s, which are order-blind, so it does
 * not *consume* the ordering. It depends on invariants the containers hide instead, and each
 * one fails silently there:
 *
 * | invariant | what breaks silently without it |
 * |---|---|
 * | `PYTHON_LOWER_SIMPLE` has even length | every pair after the gap is read shifted: key = previous value |
 * | its keys strictly ascend | a duplicate key keeps whichever entry came last |
 * | no identity pair, no key also in `EXPANSIONS` | an expansion shadowed or shadowing a simple mapping |
 * | each range has `lo <= hi` | an inverted range contributes nothing to the set |
 * | the two class tables are disjoint | a code point in both is ignorable, whatever the capture said |
 *
 * Strictly ascending keys and ranges are asserted even though a `Set` does not need them,
 * because the generator emits them that way and a hand edit that breaks the order is the
 * likeliest way any of the rows above gets broken.
 */

function pairViolations(flat: ReadonlyArray<number>, name: string): string[] {
  const out: string[] = [];
  if (flat.length % 2 !== 0) {
    out.push(`${name}: odd length ${flat.length}`);
  }
  for (let index = 0; index + 1 < flat.length; index += 2) {
    const key = flat[index];
    const value = flat[index + 1];
    if (key === value) {
      out.push(`${name}: identity pair at 0x${key.toString(16)}`);
    }
    if (index > 0 && key <= flat[index - 2]) {
      out.push(
        `${name}: key 0x${key.toString(16)} does not follow 0x${flat[index - 2].toString(16)}`,
      );
    }
    if (value < 0 || value > 0x10ffff) {
      out.push(`${name}: value out of range at 0x${key.toString(16)}`);
    }
  }
  return out;
}

function rangeViolations(flat: ReadonlyArray<number>, name: string): string[] {
  const out: string[] = [];
  if (flat.length % 2 !== 0) {
    out.push(`${name}: odd length ${flat.length}`);
  }
  for (let index = 0; index + 1 < flat.length; index += 2) {
    const lo = flat[index];
    const hi = flat[index + 1];
    if (lo > hi) {
      out.push(`${name}: pair ${index / 2} inverted 0x${lo.toString(16)} > 0x${hi.toString(16)}`);
    }
    if (index > 0 && lo <= flat[index - 1]) {
      out.push(`${name}: pair ${index / 2} overlaps or precedes 0x${flat[index - 1].toString(16)}`);
    }
  }
  return out;
}

function expandRanges(flat: ReadonlyArray<number>): Set<number> {
  const set = new Set<number>();
  for (let index = 0; index + 1 < flat.length; index += 2) {
    for (let cp = flat[index]; cp <= flat[index + 1]; cp += 1) {
      set.add(cp);
    }
  }
  return set;
}

describe('pinned CPython str.lower() tables — shape (rule 15b)', () => {
  it('PYTHON_LOWER_SIMPLE is flat [cp, lowered] pairs, strictly ascending, no identity pairs', () => {
    expect(pairViolations(PYTHON_LOWER_SIMPLE, 'SIMPLE')).toEqual([]);
  });

  it('PYTHON_LOWER_EXPANSIONS has strictly ascending keys, each expanding to 2+ code points', () => {
    const violations: string[] = [];
    PYTHON_LOWER_EXPANSIONS.forEach(([cp, lowered], index) => {
      if (lowered.length < 2) {
        violations.push(`0x${cp.toString(16)} expands to ${lowered.length}`);
      }
      if (index > 0 && cp <= PYTHON_LOWER_EXPANSIONS[index - 1][0]) {
        violations.push(`0x${cp.toString(16)} out of order`);
      }
    });
    expect(violations).toEqual([]);
  });

  it('no code point is both a simple mapping and an expansion', () => {
    const simpleKeys = new Set<number>();
    for (let index = 0; index < PYTHON_LOWER_SIMPLE.length; index += 2) {
      simpleKeys.add(PYTHON_LOWER_SIMPLE[index]);
    }
    expect(PYTHON_LOWER_EXPANSIONS.filter(([cp]) => simpleKeys.has(cp))).toEqual([]);
  });

  it.each([
    ['PYTHON_CASE_IGNORABLE_RANGES', PYTHON_CASE_IGNORABLE_RANGES],
    ['PYTHON_CASED_RANGES', PYTHON_CASED_RANGES],
  ])('%s is flat [start, end] pairs, ascending and non-overlapping', (name, ranges) => {
    expect(rangeViolations(ranges, name)).toEqual([]);
  });

  it('the case-ignorable and cased classes are disjoint (the capture assigns one class per code point)', () => {
    const ignorable = expandRanges(PYTHON_CASE_IGNORABLE_RANGES);
    const both = [...expandRanges(PYTHON_CASED_RANGES)].filter((cp) => ignorable.has(cp));
    expect(both).toEqual([]);
  });

  it('carries the sizes measured at capture (CPython 3.9.25, UCD 13.0.0, 2026-09-12)', () => {
    // A regeneration against a different interpreter changes these; that must be a visible
    // diff in review, not a silent table swap.
    expect(PYTHON_LOWER_SIMPLE.length / 2).toBe(1392);
    expect(PYTHON_LOWER_EXPANSIONS.length).toBe(1);
    expect(expandRanges(PYTHON_CASE_IGNORABLE_RANGES).size).toBe(2413);
    expect(expandRanges(PYTHON_CASED_RANGES).size).toBe(4141);
  });

  it('PYTHON_LOWER_CONTEXT_FIXTURE has no duplicate input', () => {
    const inputs = PYTHON_LOWER_CONTEXT_FIXTURE.map(([input]) => input);
    expect(new Set(inputs).size).toBe(inputs.length);
  });
});
