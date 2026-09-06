import { describe, expect, it } from '@jest/globals';
import { normalizeEmail } from './user.service';

/**
 * `UserManager.normalize_email`, differentially captured.
 *
 * Every expected value below was produced by running the input through
 * `django.contrib.auth.models.UserManager().normalize_email` inside the pinned v1 container
 * (`fondo-v1-p4`, Django 2.2.27 / CPython 3.9) — none of it is transcribed from belief.
 *
 * Two properties this pins, both of which v2 got wrong before (parity finding **DELTA3-F1**):
 *
 *  1. **The strip is conditional.** `email.strip().rsplit('@', 1)` unpacks into two names; with
 *     no `@` that raises `ValueError`, the `except` swallows it, and the **original** value is
 *     returned — unstripped. `'  nodomain  '` keeps its spaces.
 *  2. **`strip()` is not `trim()`.** CPython strips U+001C-U+001F and U+0085, which JS keeps;
 *     JS strips U+FEFF, which CPython keeps. Both directions are pinned below, so swapping in
 *     `String.prototype.trim()` fails this suite rather than passing it.
 */
describe('normalizeEmail — differential against the v1 container', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['  a@b.com  ', 'a@b.com'],
    ['a@B.COM', 'a@b.com'],
    [' x@Y.Com ', 'x@y.com'],
    ['nodomain', 'nodomain'],
    ['  nodomain  ', '  nodomain  '],
    ['a@b@c.COM', 'a@b@c.com'],
    ['@b.com', '@b.com'],
    ['a@', 'a@'],
    ['a@b.com', 'a@b.com'],
    ['\u0009a@b.com\u000a', 'a@b.com'],
    ['\u001ca@b.com\u001f', 'a@b.com'],
    ['\u0085a@b.com\u0085', 'a@b.com'],
    ['\ufeffa@b.com\ufeff', '\ufeffa@b.com\ufeff'],
    ['\u00a0a@b.com\u00a0', 'a@b.com'],
    ['\u3000a@b.com\u3000', 'a@b.com'],
    ['\u200ba@b.com\u200b', '\u200ba@b.com\u200b'],
  ];

  it.each(cases)('normalize_email(%j) === %j', (input, expected) => {
    expect(normalizeEmail(input)).toBe(expected);
  });

  it('strips U+001C-U+001F and U+0085, which JS trim() does not', () => {
    expect(normalizeEmail('\u001fa@b.com\u0085')).toBe('a@b.com');
    expect('\u001fa@b.com\u0085'.trim()).not.toBe('a@b.com');
  });

  it('keeps U+FEFF, which JS trim() would strip', () => {
    expect(normalizeEmail('\ufeffa@b.com\ufeff')).toBe('\ufeffa@b.com\ufeff');
    expect('\ufeffa@b.com\ufeff'.trim()).toBe('a@b.com');
  });
});
