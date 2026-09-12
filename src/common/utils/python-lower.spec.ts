import { pythonLower } from './python-lower';
import {
  PYTHON_CASED_RANGES,
  PYTHON_CASE_IGNORABLE_RANGES,
  PYTHON_LOWER_CONTEXT_FIXTURE,
  PYTHON_LOWER_EXPANSIONS,
  PYTHON_LOWER_SIMPLE,
} from './python-lower.fixture';

/**
 * `pythonLower` against CPython 3.9.25's own answers (`PYTHON_LOWER_CONTEXT_FIXTURE`, captured by
 * `scripts/gen-python-lower-fixture.py`).
 *
 * ## The wrong implementations these cells are built to fail
 *
 * Enumerated first, then a row picked for each. Every one of them was also planted in
 * `python-lower.ts` and run against this file; the result is in `docs/phase-8-deviations.md`.
 *
 * | # | plausible wrong implementation | row that separates it |
 * |---|---|---|
 * | W1 | `value.toLowerCase()` | `Ᲊ` (U+1C89): Node lowercases it, CPython 3.9 does not |
 * | W2 | per-code-point table, Σ always `σ` | `ΟΔΟΣ` → `οδος` with a final `ς` |
 * | W3 | the sigma rule over Node's `\p{Case_Ignorable}` / `\p{Cased}` | `ʕΣ`, `Α࢈Σ`, `Α᜴Σ`, `ᲉΣ` |
 * | W4 | iterating UTF-16 code units | `𐐀` (U+10400) → `𐐨` |
 * | W5 | dropping the expansion (`İ` → `i`, or unchanged) | `İ` → `i̇` |
 * | W6 | not skipping case-ignorables after Σ | `ΑΣ́` → final `ς` |
 * | W7 | not looking *before* Σ | `1Σ`, ` Σ` → `σ` |
 * | W8 | asking "cased?" before "ignorable?" (with a cased table that includes U+0345) | `ΑΣͅ` → `ς` |
 *
 * ⚠️ **Not in the table: reading the *lowered* neighbours instead of the original ones.** It
 * was enumerated, and it is an equivalent mutant on this UCD: measured 2026-09-12 over all
 * 1,393 code points with a lowercase mapping, the case class Σ's scan lands on is the same
 * for the original code point and for its lowered form, in both directions (0 of 1,393
 * differ). No row can separate it, so none is claimed to.
 */
describe('pythonLower', () => {
  it.each(
    PYTHON_LOWER_CONTEXT_FIXTURE.map(([input, expected]) => [escape(input), input, expected]),
  )('CPython: %s', (_label, input, expected) => {
    expect(pythonLower(input)).toBe(expected);
  });

  describe('the fixture still separates the runtime-dependent wrong implementations (this Node)', () => {
    it('W1 — at least one row where toLowerCase() disagrees with CPython', () => {
      const disagreeing = PYTHON_LOWER_CONTEXT_FIXTURE.filter(
        ([input, expected]) => input.toLowerCase() !== expected,
      ).map(([input]) => escape(input));
      expect(disagreeing.length).toBeGreaterThan(0);
    });

    it("W3 — at least one row where the sigma rule over Node's own properties disagrees", () => {
      const ignorable = /^\p{Case_Ignorable}$/u;
      const cased = /^\p{Cased}$/u;
      const nodeClassLower = (value: string): string => {
        const cps = Array.from(value);
        return cps
          .map((ch, index) => {
            if (ch !== 'Σ') {
              return ch.toLowerCase();
            }
            let before = index - 1;
            while (before >= 0 && ignorable.test(cps[before])) before -= 1;
            let finalSigma = before >= 0 && cased.test(cps[before]);
            if (finalSigma && index + 1 < cps.length) {
              let after = index + 1;
              while (after < cps.length && ignorable.test(cps[after])) after += 1;
              finalSigma = after === cps.length || !cased.test(cps[after]);
            }
            return finalSigma ? 'ς' : 'σ';
          })
          .join('');
      };
      const disagreeing = PYTHON_LOWER_CONTEXT_FIXTURE.filter(
        ([input, expected]) => nodeClassLower(input) !== expected,
      ).map(([input]) => escape(input));
      expect(disagreeing).toEqual(
        expect.arrayContaining([
          '\\u0295\\u03a3',
          '\\u0391\\u0888\\u03a3',
          '\\u0391\\u1734\\u03a3',
          '\\u1c89\\u03a3',
        ]),
      );
    });
  });

  it('passes a lone surrogate through unchanged, as CPython does', () => {
    expect(pythonLower('a\ud800B')).toBe('a\ud800b');
  });

  it('agrees with a naive reading of the tables on every single code point (W4, loader bugs)', () => {
    const simple: Record<number, number> = {};
    for (let index = 0; index < PYTHON_LOWER_SIMPLE.length; index += 2) {
      simple[PYTHON_LOWER_SIMPLE[index]] = PYTHON_LOWER_SIMPLE[index + 1];
    }
    const expansions: Record<number, string> = {};
    for (const [cp, lowered] of PYTHON_LOWER_EXPANSIONS) {
      expansions[cp] = String.fromCodePoint(...lowered);
    }
    const mismatches: string[] = [];
    for (let cp = 0; cp <= 0x10ffff && mismatches.length < 10; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) {
        continue;
      }
      const expected =
        cp === 0x3a3
          ? 'σ' // a lone Σ has no cased neighbour, so it is never final
          : (expansions[cp] ?? String.fromCodePoint(simple[cp] ?? cp));
      if (pythonLower(String.fromCodePoint(cp)) !== expected) {
        mismatches.push(`U+${cp.toString(16).toUpperCase()}`);
      }
    }
    expect(mismatches).toEqual([]);
  }, 60_000);

  it('classifies a sigma neighbour from both captured tables, not one (W3 inverse)', () => {
    // A cased code point that is only in PYTHON_CASED_RANGES, and an ignorable one only in
    // PYTHON_CASE_IGNORABLE_RANGES — the smallest of each, so a loader that drops a table fails.
    const firstCased = PYTHON_CASED_RANGES[0];
    const firstIgnorable = PYTHON_CASE_IGNORABLE_RANGES[0];
    const cased = String.fromCodePoint(firstCased);
    const ignorable = String.fromCodePoint(firstIgnorable);
    expect(pythonLower(`${cased}Σ`).endsWith('ς')).toBe(true);
    expect(pythonLower(`${cased}${ignorable}Σ`).endsWith('ς')).toBe(true);
  });
});

function escape(value: string): string {
  return Array.from(value)
    .map((ch) => {
      const cp = ch.codePointAt(0) as number;
      return cp >= 0x20 && cp < 0x7f
        ? ch
        : cp > 0xffff
          ? `\\u{${cp.toString(16)}}`
          : `\\u${cp.toString(16).padStart(4, '0')}`;
    })
    .join('');
}
