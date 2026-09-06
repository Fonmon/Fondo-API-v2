# -*- coding: utf-8 -*-
"""Emit a TS fixture of `str(json.loads(<body>))` for the shapes a JSON body can carry.

Run inside the pinned v1 container (CPython 3.9 / Django 2.2.27); the values are what
`TextField.get_prep_value` stores.
"""
import json
import sys
from django.db.models import TextField  # noqa: E402

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
]

rows = []
for body in BODIES:
    value = json.loads(body)
    rows.append((body, TextField().get_prep_value(value)))

out = []
out.append('/* eslint-disable */')
out.append('// GENERATED — do not edit by hand. See `scripts/gen-python-str-fixture.py`.')
out.append('//')
out.append('// Captured from the pinned v1 stack (CPython %s / Django 2.2.27) by running' % sys.version.split()[0])
out.append("// `TextField().get_prep_value(json.loads(body))` inside the `fondo-v1-p4` container.")
out.append('// Each row is [request-body JSON, the exact string Django sends to the column].')
out.append('// `null` means Django sends SQL NULL.')
out.append('')
out.append('export const DJANGO_TEXT_PREP_FIXTURE: ReadonlyArray<readonly [string, string | null]> = [')
for body, prepped in rows:
    out.append('  [%s, %s],' % (json.dumps(body), 'null' if prepped is None else json.dumps(prepped)))
out.append('];')
out.append('')
sys.stdout.write('\n'.join(out))
