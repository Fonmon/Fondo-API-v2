# -*- coding: utf-8 -*-
"""Emit a TS fixture of `str(json.loads(<body>))` for the shapes a JSON body can carry.

Run inside the pinned v1 container (CPython 3.9 / Django 2.2.27); the values are what
`TextField.get_prep_value` stores:

    docker cp scripts/gen-python-str-fixture.py fondo-v1-p4:/tmp/gen.py
    docker exec -w /app fondo-v1-p4 python -c "import django,os; \
        os.environ.setdefault('DJANGO_SETTINGS_MODULE','fondo.settings'); django.setup(); \
        exec(open('/tmp/gen.py').read())" > src/common/utils/python-str.fixture.ts

Three tables come out of it, and the second and third are the ones that make the module's
"Known limits" block checkable rather than merely stated:

1. `DJANGO_TEXT_PREP_FIXTURE`  — bodies where v1 and v2 must **agree**, byte for byte.
2. `DJANGO_TEXT_PREP_DIVERGENCES` — bodies where they are known to **disagree**, carrying v1's
   value. `python-obj.spec.ts` pairs each with the value v2 produces, so a limit that is
   silently closed (or silently widened) fails a cell instead of ageing into a false claim.
3. `PYTHON_NONPRINTABLE_RANGES` — `str.isprintable()` captured from the pinned interpreter's
   Unicode database (UCD 13.0.0). Node ships a much newer UCD, so `\\p{Cn}` disagrees with v1
   on 15 933 code points; see the module docblock.
4. `PYTHON_DECIMAL_DIGIT_RANGES` — the code points `int()` folds onto an ASCII digit, from the
   same UCD, for the same reason: `\\p{Nd}` is 650 code points here and 770 on Node 24.
"""
import json
import sys
import unicodedata
from django.db.models import TextField  # noqa: E402

# Bodies where v1 and v2 agree. A row here is a regression detector.
BODIES = [
    '["a"]', '[1, 2]', '[]', '{"a": 1}', '{}', '{"a": [1, {"b": 2}]}',
    '5', '5.5', '-0', 'true', 'false', 'null', '"x"', '""',
    '["a\'b"]', '["a\\"b"]', '["a\'b\\"c"]', '["a\\nb"]', '["a\\\\b"]',
    '["a\\tb"]', '["a\\rb"]', '["a\\u0000b"]', '["\\u007f"]',
    '["\\u200b"]', '["\\u00a0"]', '["\\u2028"]', '["\\u00ad"]',
    '["\\u00f1"]', '["\\u20ac"]', '["\\ud83d\\ude00"]',
    '[null]', '[true, false]', '[[1], [2]]', '[{"k": "v"}]',
    '{"a": "b"}', '{"a": null}', '{"a": true}', '{"a": "\'"}',
    '["Parity probe \\u00f1"]', '{"nested": {"deep": ["x", null, true]}}',
    '[1, "two", null, true, {"three": 3}]',

    # --- C60: CPython switches to exponential notation iff `decpt <= -4 or decpt > 16`;
    # ECMA-262 iff `decpt <= -6 or decpt > 21`. Both boundaries, from both sides, so an
    # off-by-one in either direction fails a cell rather than passing unseen.
    '0.001',                 # decpt -2  : fixed in both — inside the band
    '0.0001',                # decpt -3  : fixed in both — last fixed value before the switch
    '0.00001',               # decpt -4  : FIRST exponential for CPython, fixed for JS
    '1.5e-5',                # decpt -4  : same boundary with a two-digit mantissa
    '1e-6',                  # decpt -5  : still fixed for JS
    '1e-7',                  # decpt -6  : exponential in both; pins the two-digit padding
    '-0.00001',              # decpt -4  : the low boundary carrying a sign
    '1e-323',                # subnormal : three-digit exponent, not padded further
    '4503599627370495.5',    # decpt 16  : the largest non-integral double — fixed in both
    '1e16',                  # decpt 17  : FIRST exponential for CPython, fixed for JS
    '1.5e16',                # decpt 17  : same boundary, two-digit mantissa
    '1e17',                  # decpt 18
    '-1e16',                 # decpt 17  : the high boundary carrying a sign
    '1e21',                  # decpt 22  : exponential in both — the old limit 2's own value
    '1.7976931348623157e308',  # DBL_MAX : three-digit exponent
    '[1.5e-5, 1e16]',        # both boundaries nested, since containers repr their elements
    '{"a": 1e17}',
]

# Bodies where v1 and v2 are known to DISAGREE. Each is an instance of a "Known limits" entry;
# `python-obj.spec.ts` asserts both sides, so closing or widening a limit breaks a cell.
DIVERGENT_BODIES = [
    # limit 1(a) — an integral float loses its `.0`
    '5.0',
    '-2.0',
    '1e-330',                # underflows to 0.0; v1 stores '0.0'
    # limit 1(b) — negative zero loses its sign
    '-0.0',
    # limit 1(c) — an int literal at or beyond CPython's exponential threshold
    '10000000000000000',     # 1e16 written as an int
    '9999999999999999',
    '1000000000000000000000',  # the old limit 2's value: 10**21
    # limit 2 — dict key order: JS hoists integer-like keys
    '{"b": 1, "1": 2}',
    '{"10": 0, "9": 1}',
]


def prep(body):
    return TextField().get_prep_value(json.loads(body))


def nonprintable_ranges():
    """`str.isprintable()` for every code point, as [start, end] ranges of NON-printable ones.

    Surrogates are forced non-printable: `chr(0xd800)` is category `Cs` and CPython agrees,
    but `json.loads` on a lone surrogate escape is a different question and is not this table's.
    """
    out = []
    for cp in range(0x110000):
        np = True if 0xD800 <= cp <= 0xDFFF else not chr(cp).isprintable()
        if not np:
            continue
        if out and out[-1][1] == cp - 1:
            out[-1][1] = cp
        else:
            out.append([cp, cp])
    return out


def decimal_digit_ranges():
    """The code points CPython's `int()` reads as a decimal digit, as [start, end] runs.

    `int()` does not test a category: `PyLong_FromUnicodeObject` first runs
    `_PyUnicode_TransformDecimalAndSpaceToASCII`, which maps every code point whose
    `Py_UNICODE_TODECIMAL` is non-negative onto the matching ASCII digit. Measured over all
    1 114 112 code points on this interpreter, that set is **exactly** general category `Nd`
    and the digit value is always `(cp - run_start) % 10` — asserted below rather than assumed,
    so a future UCD that breaks either property fails the generator instead of the fixture.

    ⚠️ Captured rather than asked of Node for the same reason `nonprintable_ranges` is: `Nd`
    moves. This interpreter (UCD 13.0.0) has 650 such code points; Node 24 (UCD 17.0) has 770.
    """
    nd = [cp for cp in range(0x110000)
          if unicodedata.category(chr(cp)) == 'Nd']
    accepted = set()
    for cp in nd:
        try:
            int(chr(cp))
        except ValueError:
            continue
        accepted.add(cp)
    assert accepted == set(nd), 'int() and category Nd disagree on this interpreter'
    out = []
    for cp in nd:
        if out and out[-1][1] == cp - 1:
            out[-1][1] = cp
        else:
            out.append([cp, cp])
    for start, end in out:
        for cp in range(start, end + 1):
            assert unicodedata.digit(chr(cp)) == (cp - start) % 10, hex(cp)
    return out


out = []
out.append('/* eslint-disable */')
out.append('// GENERATED — do not edit by hand. See `scripts/gen-python-str-fixture.py`.')
out.append('//')
out.append('// Captured from the pinned v1 stack (CPython %s / Django 2.2.27) by running'
           % sys.version.split()[0])
out.append("// `TextField().get_prep_value(json.loads(body))` inside the `fondo-v1-p4` container.")
out.append('// Each row is [request-body JSON, the exact string Django sends to the column].')
out.append('// `null` means Django sends SQL NULL.')
out.append('')
out.append('export const DJANGO_TEXT_PREP_FIXTURE: ReadonlyArray<readonly [string, string | null]> = [')
for body in BODIES:
    prepped = prep(body)
    out.append('  [%s, %s],' % (json.dumps(body), 'null' if prepped is None else json.dumps(prepped)))
out.append('];')
out.append('')
out.append('// Bodies v2 renders DIFFERENTLY, on purpose — one per "Known limits" entry in')
out.append('// `python-str.ts`. The value here is **v1**\'s; the spec carries v2\'s beside it.')
out.append('export const DJANGO_TEXT_PREP_DIVERGENCES: ReadonlyArray<readonly [string, string]> = [')
for body in DIVERGENT_BODIES:
    out.append('  [%s, %s],' % (json.dumps(body), json.dumps(prep(body))))
out.append('];')
out.append('')
out.append("// `str.isprintable()` from the pinned interpreter's Unicode database (UCD %s),"
           % unicodedata.unidata_version)
out.append('// as [start, end] ranges of code points that are NOT printable — i.e. the ones')
out.append("// CPython's `repr()` escapes. Flat pairs, ascending, non-overlapping.")
out.append('export const PYTHON_NONPRINTABLE_RANGES: ReadonlyArray<number> = [')
ranges = nonprintable_ranges()
for i in range(0, len(ranges), 8):
    chunk = ranges[i:i + 8]
    out.append('  ' + ' '.join('0x%x, 0x%x,' % (a, b) for a, b in chunk))
out.append('];')
out.append('')
out.append("// The code points CPython's `int()` accepts as decimal digits, from the pinned")
out.append('// interpreter\'s Unicode database (UCD %s), as [start, end] runs of code points.'
           % unicodedata.unidata_version)
out.append('// The digit value of a code point is `(cp - start) % 10`. Flat pairs, ascending.')
out.append('export const PYTHON_DECIMAL_DIGIT_RANGES: ReadonlyArray<number> = [')
digit_ranges = decimal_digit_ranges()
for i in range(0, len(digit_ranges), 8):
    chunk = digit_ranges[i:i + 8]
    out.append('  ' + ' '.join('0x%x, 0x%x,' % (a, b) for a, b in chunk))
out.append('];')
out.append('')
sys.stdout.write('\n'.join(out))
