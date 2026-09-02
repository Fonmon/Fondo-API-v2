import { randomInt, timingSafeEqual } from 'node:crypto';

/**
 * `django.middleware.csrf` reduced to what v1's two form POSTs need — condition-free, because
 * v1's `MIDDLEWARE` really does include `CsrfViewMiddleware` (`api/settings/base.py:42`) and
 * `PasswordResetView` really is wrapped in `@method_decorator(csrf_protect)`.
 *
 * ## Why this is not "skip it, it is an API"
 *
 * Phase 1 correctly left CSRF unmodelled: every DRF view is exempt (DRF's `APIView` is
 * `csrf_exempt`). Phase 3 lands the **only four Django form pages in the service**, and there
 * the check is live: `POST /password_reset/` without a `csrftoken` cookie is a **403** in v1,
 * not a redirect.
 *
 * ## The token format is Django's, deliberately
 *
 * A CSRF token is a 32-character secret from `[a-zA-Z0-9]`, transported **masked**: 64
 * characters, where the first 32 are a random salt and the last 32 are the secret shifted
 * character-wise by it (`_mask_cipher_secret`). Every render produces a fresh mask of the same
 * secret, which is why the cookie and the form field never look alike and why comparison has
 * to unmask both (`_compare_salted_tokens`).
 *
 * Reproducing the format rather than inventing one keeps `manual-tester` able to drive **both**
 * systems from one browser session and keeps the cookie's shape identical in a header diff.
 *
 * ## What is deliberately not ported
 *
 * `CsrfViewMiddleware.process_view` also performs a `Referer` check — but **only** when
 * `request.is_secure()`, and v1 sets no `SECURE_PROXY_SSL_HEADER`, so behind its load balancer
 * `is_secure()` is `False` and that branch never runs in production. Omitted, and registered.
 */

/** `django.middleware.csrf.CSRF_ALLOWED_CHARS`. */
const CSRF_ALLOWED_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** `django.middleware.csrf.CSRF_SECRET_LENGTH`. */
export const CSRF_SECRET_LENGTH = 32;

/** `settings.CSRF_COOKIE_NAME`, Django's default. */
export const CSRF_COOKIE_NAME = 'csrftoken';

/** The form field `{% csrf_token %}` renders, and the header DRF clients use. */
export const CSRF_FIELD_NAME = 'csrfmiddlewaretoken';
export const CSRF_HEADER_NAME = 'x-csrftoken';

/** `settings.CSRF_COOKIE_AGE` — one year, in seconds. */
export const CSRF_COOKIE_AGE = 31449600;

/**
 * `_get_new_csrf_string()` — 32 characters from `CSRF_ALLOWED_CHARS`.
 *
 * (Django 2.2 names the pair `_salt_cipher_secret` / `_unsalt_cipher_token`; the "mask"
 * spelling below is the later Django name for the same functions and reads less confusingly
 * next to the password hasher's *other* kind of salt.)
 */
export function newCsrfSecret(): string {
  let out = '';
  for (let i = 0; i < CSRF_SECRET_LENGTH; i += 1) {
    out += CSRF_ALLOWED_CHARS[randomInt(CSRF_ALLOWED_CHARS.length)];
  }
  return out;
}

/**
 * `_salt_cipher_secret(secret)` (Django 2.2, `middleware/csrf.py:45-53`):
 *
 * ```python
 * mask = _get_new_csrf_string()
 * chars = CSRF_ALLOWED_CHARS
 * pairs = zip((chars.index(x) for x in secret), (chars.index(x) for x in mask))
 * cipher = ''.join(chars[(x + y) % len(chars)] for x, y in pairs)
 * return mask + cipher
 * ```
 */
export function maskCsrfSecret(secret: string, mask: string = newCsrfSecret()): string {
  let cipher = '';
  for (let i = 0; i < secret.length; i += 1) {
    const x = CSRF_ALLOWED_CHARS.indexOf(secret[i]);
    const y = CSRF_ALLOWED_CHARS.indexOf(mask[i]);
    cipher += CSRF_ALLOWED_CHARS[(x + y) % CSRF_ALLOWED_CHARS.length];
  }
  return mask + cipher;
}

/**
 * `_unsalt_cipher_token(token)` — the inverse shift. Django writes it `chars[x - y]`, relying
 * on Python's negative indexing, which is `(x - y) mod 62`.
 *
 * A 32-character token is returned unchanged: Django accepts the legacy unmasked form so that
 * cookies written by an older release keep working.
 */
export function unmaskCsrfToken(token: string): string | null {
  if (token.length === CSRF_SECRET_LENGTH) {
    return isCsrfCharset(token) ? token : null;
  }
  if (token.length !== CSRF_SECRET_LENGTH * 2 || !isCsrfCharset(token)) {
    return null;
  }
  const mask = token.slice(0, CSRF_SECRET_LENGTH);
  const cipher = token.slice(CSRF_SECRET_LENGTH);
  let secret = '';
  for (let i = 0; i < CSRF_SECRET_LENGTH; i += 1) {
    const x = CSRF_ALLOWED_CHARS.indexOf(cipher[i]);
    const y = CSRF_ALLOWED_CHARS.indexOf(mask[i]);
    secret +=
      CSRF_ALLOWED_CHARS[
        (((x - y) % CSRF_ALLOWED_CHARS.length) + CSRF_ALLOWED_CHARS.length) %
          CSRF_ALLOWED_CHARS.length
      ];
  }
  return secret;
}

/**
 * `_compare_salted_tokens(request_csrf_token, csrf_token)` — unmask both, then
 * `constant_time_compare`.
 */
export function csrfTokensMatch(cookieToken: string, requestToken: string): boolean {
  const left = unmaskCsrfToken(cookieToken);
  const right = unmaskCsrfToken(requestToken);
  if (left === null || right === null || left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

/**
 * `_sanitize_token(token)` — a cookie value that is not 64 (or legacy 32) alphanumeric
 * characters is discarded and replaced by a fresh one, and the cookie is reset.
 *
 * @returns the token to use, and whether it had to be replaced.
 */
export function sanitizeCsrfToken(token: string | undefined): {
  token: string;
  replaced: boolean;
} {
  if (token !== undefined && isCsrfCharset(token)) {
    if (token.length === CSRF_SECRET_LENGTH * 2) {
      return { token, replaced: false };
    }
    if (token.length === CSRF_SECRET_LENGTH) {
      // "Older Django versions set cookies to values of CSRF_SECRET_LENGTH … accept such
      // values as unsalted secrets."
      return { token: maskCsrfSecret(token), replaced: true };
    }
  }
  return { token: maskCsrfSecret(newCsrfSecret()), replaced: true };
}

/** `django.middleware.csrf.REASON_NO_CSRF_COOKIE`. */
export const REASON_NO_CSRF_COOKIE = 'CSRF cookie not set.';
/** `django.middleware.csrf.REASON_BAD_TOKEN`. */
export const REASON_BAD_TOKEN = 'CSRF token missing or incorrect.';

function isCsrfCharset(token: string): boolean {
  return /^[a-zA-Z0-9]+$/.test(token);
}
