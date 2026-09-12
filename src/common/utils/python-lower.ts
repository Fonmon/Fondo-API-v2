import {
  PYTHON_CASED_RANGES,
  PYTHON_CASE_IGNORABLE_RANGES,
  PYTHON_LOWER_EXPANSIONS,
  PYTHON_LOWER_SIMPLE,
} from './python-lower.fixture';

/**
 * CPython 3.9's `str.lower()`, driven by tables captured from the pinned v1 interpreter —
 * Phase 8, measurement 7.
 *
 * ## Why not `toLowerCase()`
 *
 * `FileService.save_file` and `get_signed_url` both build the GCS object path as
 * `"{type_display}/{display_name.lower()}"`. A different lowered name is a different object.
 * Measured on 2026-09-12 against the pinned image (CPython 3.9.25, UCD 13.0.0) and Node
 * 24.20.0 (Unicode 17.0):
 *
 * | axis | code points where Node's answer differs from CPython's |
 * |---|---|
 * | single-code-point `lower()` (e.g. U+1C89, U+2C2F, U+A7C0) | **95** |
 * | final-sigma context classes (`Case_Ignorable` / `Cased`) (e.g. U+0295, U+0888, U+1734) | **610** |
 *
 * 0 of the 37 names on `fondodev` hit either set (measured the same day), so the difference
 * can only reach a future upload — which is where it would do damage: the upload lands beside
 * the existing object, `blob.exists()` says `False`, and the row insert then fails on
 * `display_name`'s unique constraint (a partial write; see `docs/phase-8-deviations.md`).
 *
 * ## What is reproduced, and what was checked
 *
 * `lower_ucs4` in CPython 3.9's `unicodeobject.c` has exactly two inputs, both captured in
 * `python-lower.fixture.ts` by `scripts/gen-python-lower-fixture.py`:
 *
 *  1. the full lowercase mapping per code point, including the one expansion (U+0130 → `i̇`);
 *  2. for **U+03A3 only**, `handle_capital_sigma`, which skips case-ignorable neighbours in
 *     the *original* string and then asks whether the first other neighbour is cased.
 *
 * The generator re-implements this algorithm from its own tables and compares it to CPython's
 * `str.lower()` before it prints anything. The counts it checked are in the fixture header;
 * they are a measurement taken at generation, not something CI re-runs (CI has no CPython).
 * What CI does check is the tables' shape (`python-lower.fixture.spec.ts`, plan §4 rule 15b)
 * and the context rows (`python-lower.spec.ts`), each row chosen to fail one enumerated wrong
 * implementation.
 *
 * Not validated, therefore not claimed: `str.casefold()`, `str.upper()`/`title()`, and any
 * interpreter other than the pinned 3.9.25. A lone surrogate is passed through unchanged, as
 * CPython does; it cannot be encoded as an object name, and the storage adapter refuses it.
 */
export function pythonLower(value: string): string {
  const codePoints = Array.from(value, (ch) => ch.codePointAt(0) as number);
  let out = '';
  for (let index = 0; index < codePoints.length; index += 1) {
    const codePoint = codePoints[index];
    if (codePoint === CAPITAL_SIGMA) {
      out += String.fromCodePoint(isFinalSigma(codePoints, index) ? FINAL_SIGMA : SMALL_SIGMA);
      continue;
    }
    const expansion = EXPANSIONS.get(codePoint);
    if (expansion !== undefined) {
      out += expansion;
      continue;
    }
    out += String.fromCodePoint(SIMPLE.get(codePoint) ?? codePoint);
  }
  return out;
}

const CAPITAL_SIGMA = 0x3a3;
const SMALL_SIGMA = 0x3c3;
const FINAL_SIGMA = 0x3c2;

/**
 * ```c
 * static Py_UCS4 handle_capital_sigma(int kind, void *data, Py_ssize_t length, Py_ssize_t i)
 * {
 *     for (j = i - 1; j >= 0; j--) {
 *         c = PyUnicode_READ(kind, data, j);
 *         if (!_PyUnicode_IsCaseIgnorable(c)) break;
 *     }
 *     final_sigma = j >= 0 && _PyUnicode_IsCased(c);
 *     if (final_sigma && i + 1 < length) {
 *         for (j = i + 1; j < length; j++) {
 *             c = PyUnicode_READ(kind, data, j);
 *             if (!_PyUnicode_IsCaseIgnorable(c)) break;
 *         }
 *         final_sigma = j == length || !_PyUnicode_IsCased(c);
 *     }
 *     return (final_sigma) ? 0x3C2 : 0x3C3;
 * }
 * ```
 *
 * ⚠️ Ignorable is asked **before** cased, and U+0345 is both — so "skip the cased ones first"
 * is a different function, and `python-lower.spec.ts` has the row that tells them apart.
 */
function isFinalSigma(codePoints: readonly number[], index: number): boolean {
  let before = index - 1;
  while (before >= 0 && CASE_IGNORABLE.has(codePoints[before])) {
    before -= 1;
  }
  let finalSigma = before >= 0 && CASED.has(codePoints[before]);
  if (finalSigma && index + 1 < codePoints.length) {
    let after = index + 1;
    while (after < codePoints.length && CASE_IGNORABLE.has(codePoints[after])) {
      after += 1;
    }
    finalSigma = after === codePoints.length || !CASED.has(codePoints[after]);
  }
  return finalSigma;
}

/**
 * Built once, order-blind. A `Map` would silently keep the last of two entries for one code
 * point, and an inverted range would silently contribute nothing — which is why the fixture's
 * shape (strictly ascending keys, `lo <= hi`) is asserted in a spec rather than assumed here.
 */
const SIMPLE: ReadonlyMap<number, number> = pairsToMap(PYTHON_LOWER_SIMPLE);
const EXPANSIONS: ReadonlyMap<number, string> = new Map(
  PYTHON_LOWER_EXPANSIONS.map(([codePoint, lowered]) => [
    codePoint,
    String.fromCodePoint(...lowered),
  ]),
);
const CASE_IGNORABLE: ReadonlySet<number> = rangesToSet(PYTHON_CASE_IGNORABLE_RANGES);
const CASED: ReadonlySet<number> = rangesToSet(PYTHON_CASED_RANGES);

function pairsToMap(flat: ReadonlyArray<number>): Map<number, number> {
  const map = new Map<number, number>();
  for (let index = 0; index + 1 < flat.length; index += 2) {
    map.set(flat[index], flat[index + 1]);
  }
  return map;
}

function rangesToSet(flat: ReadonlyArray<number>): Set<number> {
  const set = new Set<number>();
  for (let index = 0; index + 1 < flat.length; index += 2) {
    for (let codePoint = flat[index]; codePoint <= flat[index + 1]; codePoint += 1) {
      set.add(codePoint);
    }
  }
  return set;
}
