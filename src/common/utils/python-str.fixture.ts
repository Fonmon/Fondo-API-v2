/* eslint-disable */
// GENERATED — do not edit by hand. See `scripts/gen-python-str-fixture.py`.
//
// Captured from the pinned v1 stack (CPython 3.9.25 / Django 2.2.27) by running
// `TextField().get_prep_value(json.loads(body))` inside the `fondo-v1-p4` container.
// Each row is [request-body JSON, the exact string Django sends to the column].
// `null` means Django sends SQL NULL.

export const DJANGO_TEXT_PREP_FIXTURE: ReadonlyArray<readonly [string, string | null]> = [
  ["[\"a\"]", "['a']"],
  ["[1, 2]", "[1, 2]"],
  ["[]", "[]"],
  ["{\"a\": 1}", "{'a': 1}"],
  ["{}", "{}"],
  ["{\"a\": [1, {\"b\": 2}]}", "{'a': [1, {'b': 2}]}"],
  ["5", "5"],
  ["5.5", "5.5"],
  ["-0", "0"],
  ["true", "True"],
  ["false", "False"],
  ["null", null],
  ["\"x\"", "x"],
  ["\"\"", ""],
  ["[\"a'b\"]", "[\"a'b\"]"],
  ["[\"a\\\"b\"]", "['a\"b']"],
  ["[\"a'b\\\"c\"]", "['a\\'b\"c']"],
  ["[\"a\\nb\"]", "['a\\nb']"],
  ["[\"a\\\\b\"]", "['a\\\\b']"],
  ["[\"a\\tb\"]", "['a\\tb']"],
  ["[\"a\\rb\"]", "['a\\rb']"],
  ["[\"a\\u0000b\"]", "['a\\x00b']"],
  ["[\"\\u007f\"]", "['\\x7f']"],
  ["[\"\\u200b\"]", "['\\u200b']"],
  ["[\"\\u00a0\"]", "['\\xa0']"],
  ["[\"\\u2028\"]", "['\\u2028']"],
  ["[\"\\u00ad\"]", "['\\xad']"],
  ["[\"\\u00f1\"]", "['\u00f1']"],
  ["[\"\\u20ac\"]", "['\u20ac']"],
  ["[\"\\ud83d\\ude00\"]", "['\ud83d\ude00']"],
  ["[null]", "[None]"],
  ["[true, false]", "[True, False]"],
  ["[[1], [2]]", "[[1], [2]]"],
  ["[{\"k\": \"v\"}]", "[{'k': 'v'}]"],
  ["{\"a\": \"b\"}", "{'a': 'b'}"],
  ["{\"a\": null}", "{'a': None}"],
  ["{\"a\": true}", "{'a': True}"],
  ["{\"a\": \"'\"}", "{'a': \"'\"}"],
  ["[\"Parity probe \\u00f1\"]", "['Parity probe \u00f1']"],
  ["{\"nested\": {\"deep\": [\"x\", null, true]}}", "{'nested': {'deep': ['x', None, True]}}"],
  ["[1, \"two\", null, true, {\"three\": 3}]", "[1, 'two', None, True, {'three': 3}]"],
];
