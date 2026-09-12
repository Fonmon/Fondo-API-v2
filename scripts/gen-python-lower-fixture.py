# -*- coding: utf-8 -*-
"""Emit `src/common/utils/python-lower.fixture.ts` -- CPython's `str.lower()`, captured as data.

Run inside the pinned v1 image, with no network (Phase 8, measurement 7):

    docker run --rm --network none -v "$PWD/scripts":/s:ro --entrypoint python3 \
        fondo-v1:parity /s/gen-python-lower-fixture.py > src/common/utils/python-lower.fixture.ts

WHY THIS EXISTS. `FileService.save_file` builds the GCS object path from
`display_name.lower()`. Node's `toLowerCase()` is not a port of it: measured on 2026-09-12,
CPython 3.9.25 (UCD 13.0.0) and Node 24.20.0 (Unicode 17.0) disagree on the single-code-point
result for 95 code points, and on the final-sigma context classes for 610. A different lowered
name is a different object: the upload lands beside the old one, `blob.exists()` answers False,
and the row write then fails on `display_name`'s unique constraint.

WHAT str.lower() DEPENDS ON, read from CPython 3.9's `unicodeobject.c` (`do_lower`, `lower_ucs4`,
`handle_capital_sigma`) -- three inputs, all captured here:

  1. the full lowercase mapping of each code point (`_PyUnicode_ToLowerFull`), which may expand
     to several code points (U+0130 -> 'i' U+0307);
  2. for U+03A3 only, the final-sigma rule, which reads `_PyUnicode_IsCaseIgnorable` and then
     `_PyUnicode_IsCased` on the neighbours in the ORIGINAL string;
  3. nothing else -- no locale, no normalisation.

Neither property in (2) is exposed to Python code, so both are derived behaviourally per code
point:

  t1 = ('a' + SIGMA + ch).lower()[1]   'σ' iff ch is not ignorable and is cased
  t3 = ('a' + ch + SIGMA).lower()[-1]  'σ' iff ch is not ignorable and is not cased
  both 'ς'                             ch is ignorable (whether or not it is also cased,
                                       which handle_capital_sigma never asks)

SELF-CHECK. Before printing, the script re-implements lower() from the emitted tables alone and
compares it to CPython's own `str.lower()` over every code point, every context row, and a
seeded random sweep. Any disagreement aborts the generator instead of producing a fixture. The
counts it checked are written into the fixture header, as a measurement.
"""
import json
import random
import sys
import unicodedata

SIGMA = 0x3A3
SMALL_SIGMA = 0x3C3
FINAL_SIGMA = 0x3C2

simple = {}
expansions = {}
classes = {}
for cp in range(0x110000):
    ch = chr(cp)
    lo = ch.lower()
    if lo != ch:
        if len(lo) == 1:
            simple[cp] = ord(lo)
        else:
            expansions[cp] = [ord(c) for c in lo]
    t1 = ord(('a' + chr(SIGMA) + ch).lower()[1])
    t3 = ord(('a' + ch + chr(SIGMA)).lower()[-1])
    assert t1 in (SMALL_SIGMA, FINAL_SIGMA) and t3 in (SMALL_SIGMA, FINAL_SIGMA), hex(cp)
    assert not (t1 == SMALL_SIGMA and t3 == SMALL_SIGMA), hex(cp)
    if t1 == SMALL_SIGMA:
        classes[cp] = 'C'
    elif t3 == SMALL_SIGMA:
        pass  # neither: not stored
    else:
        classes[cp] = 'I'


def ranges_of(kind):
    out = []
    for cp in sorted(c for c, k in classes.items() if k == kind):
        if out and out[-1][1] == cp - 1:
            out[-1][1] = cp
        else:
            out.append([cp, cp])
    return out


def cls(cp):
    return classes.get(cp, 'O')


def model(value):
    """lower() rebuilt from the tables only -- the algorithm python-lower.ts implements."""
    cps = [ord(c) for c in value]
    out = []
    for i, cp in enumerate(cps):
        if cp == SIGMA:
            j = i - 1
            while j >= 0 and cls(cps[j]) == 'I':
                j -= 1
            final = j >= 0 and cls(cps[j]) == 'C'
            if final and i + 1 < len(cps):
                j = i + 1
                while j < len(cps) and cls(cps[j]) == 'I':
                    j += 1
                final = j == len(cps) or cls(cps[j]) != 'C'
            out.append(FINAL_SIGMA if final else SMALL_SIGMA)
        elif cp in expansions:
            out.extend(expansions[cp])
        elif cp in simple:
            out.append(simple[cp])
        else:
            out.append(cp)
    return ''.join(chr(c) for c in out)


# Rows chosen to separate the wrong implementations the spec enumerates. Each comment names
# the mistake the row exists to catch.
CONTEXT = [
    'Σ', 'ΣΑ', 'ΑΣ', 'ΑΣ ', 'ΑΣ.', 'Α.Σ', "Α'Σ", "ΑΣ'Α", 'ΑΣΑ', 'ΟΔΟΣ',
    'ΣΣ', 'ΑΣΣ', 'ΣΣΑ', 'aΣ', '1Σ', ' Σ', 'Σ1',          # no final sigma at all
    'ΑΣ́', 'ΆΣ', 'ΑΣ́Α', 'ΑΣ­', 'ΑΣ‍',  # ignorables not skipped
    'ΑΣͅ', 'ᾼΣ',                               # U+0345 is ignorable AND cased
    'ʕΣ', 'ΑΣʕ',                                 # cased in UCD 13, not in Node's
    'Α࢈Σ',                                            # ignorable in Node's UCD only
    'Α᜴Σ',                                            # ignorable in UCD 13 only
    'ᲉΣ', 'ΑΣᲉ',                                 # cased in Node's UCD only
    'Ᲊ', 'Ⱟ', 'Ꟁ', 'ǅ', 'ẞ',               # single-code-point drift / titlecase
    'İ', 'İΣ', 'ΣİΣ', 'Aİ',                               # the one expansion
    '\U00010400', '\U00010400Σ', 'Σ\U00010400', 'Α\U0001F600Σ', 'ΑΣ\U0001F600',  # astral
    '\U0001E900Σ',
    'ACTA NÚMERO 1', 'RESULTADOS 2012', 'ÑANDÚ', '', 'Ⅻ', 'Ⓐ', 'New file', 'NEW FILE',
]

rng = random.Random(20260912)
alphabet = sorted(set(
    [SIGMA, 0x41, 0x61, 0x20, 0x31, 0x2E, 0x27, 0x130, 0x345, 0x295, 0x888, 0x1734, 0x1C89,
     0x10400, 0x1F600, 0x301, 0xAD, 0x200D]
    + rng.sample(sorted(c for c, k in classes.items() if k == 'C'), 60)
    + rng.sample(sorted(c for c, k in classes.items() if k == 'I'), 60)
    + rng.sample([c for c in range(0x110000) if cls(c) == 'O' and not (0xD800 <= c <= 0xDFFF)], 60)
    + list(expansions)
))
RANDOM_STRINGS = 200000

checked_cp = 0
for cp in range(0x110000):
    ch = chr(cp)
    assert model(ch) == ch.lower(), 'single code point ' + hex(cp)
    checked_cp += 1
for row in CONTEXT:
    assert model(row) == row.lower(), 'context ' + ascii(row)
for _ in range(RANDOM_STRINGS):
    s = ''.join(chr(rng.choice(alphabet)) for _ in range(rng.randint(1, 7)))
    assert model(s) == s.lower(), 'random ' + ascii(s)


def flat(pairs):
    lines = []
    for i in range(0, len(pairs), 8):
        lines.append('  ' + ' '.join('0x%x, 0x%x,' % (a, b) for a, b in pairs[i:i + 8]))
    return lines


out = []
out.append('/* eslint-disable */')
out.append('// GENERATED -- do not edit by hand. See `scripts/gen-python-lower-fixture.py`.')
out.append('//')
out.append("// CPython %s, Unicode database %s: `str.lower()` captured as data."
           % (sys.version.split()[0], unicodedata.unidata_version))
out.append('// Measured by the generator before printing (not re-checked in CI, which has no CPython):')
out.append('// the tables below reproduce str.lower() on %d single code points, %d context rows and'
           % (checked_cp, len(CONTEXT)))
out.append('// %d seeded random strings over a %d-code-point alphabet.' % (RANDOM_STRINGS, len(alphabet)))
out.append('// Shapes are enforced by python-lower.fixture.spec.ts.')
out.append('')
out.append('/** `[cp, lowered]` flat pairs where `chr(cp).lower()` is ONE code point other than cp. Ascending by cp. */')
out.append('export const PYTHON_LOWER_SIMPLE: ReadonlyArray<number> = [')
out.extend(flat(sorted(simple.items())))
out.append('];')
out.append('')
out.append('/** Code points whose `lower()` is more than one code point. Ascending by cp. */')
out.append('export const PYTHON_LOWER_EXPANSIONS: ReadonlyArray<readonly [number, ReadonlyArray<number>]> = [')
for cp in sorted(expansions):
    out.append('  [0x%x, [%s]],' % (cp, ', '.join('0x%x' % c for c in expansions[cp])))
out.append('];')
out.append('')
out.append('/** `_PyUnicode_IsCaseIgnorable`, as [start, end] flat pairs. Ascending, non-overlapping. */')
out.append('export const PYTHON_CASE_IGNORABLE_RANGES: ReadonlyArray<number> = [')
out.extend(flat(ranges_of('I')))
out.append('];')
out.append('')
out.append('/** `_PyUnicode_IsCased` and NOT case-ignorable, as [start, end] flat pairs. Ascending, non-overlapping. */')
out.append('export const PYTHON_CASED_RANGES: ReadonlyArray<number> = [')
out.extend(flat(ranges_of('C')))
out.append('];')
out.append('')
out.append('/** `[input, input.lower()]` from the pinned interpreter. */')
out.append('export const PYTHON_LOWER_CONTEXT_FIXTURE: ReadonlyArray<readonly [string, string]> = [')
for row in CONTEXT:
    out.append('  [%s, %s],' % (json.dumps(row), json.dumps(row.lower())))
out.append('];')
out.append('')
sys.stdout.write('\n'.join(out))
