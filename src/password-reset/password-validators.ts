/**
 * `settings.AUTH_PASSWORD_VALIDATORS` (`api/settings/base.py:106-113`), which is a **short**
 * list — v1 removed Django's defaults for minimum length and common passwords and kept two:
 *
 * ```python
 * 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'
 * 'django.contrib.auth.password_validation.NumericPasswordValidator'
 * ```
 *
 * They run on `SetPasswordForm.clean_new_password2`, i.e. on the password-reset confirm page —
 * the only place in this service where a member chooses a password. `activate_user` does
 * **not** validate: it calls `set_password` directly (`services/user.py:118`), so a member can
 * activate with `12345678` and then be refused the same password on a later reset. That
 * asymmetry is v1's and is ported.
 *
 * Messages are English because `LANGUAGE_CODE = 'en-us'` (`base.py:118`), even though every
 * page around them is Spanish. Captured from a real `Django==2.2.27` render, not translated.
 */

export interface PasswordValidationSubject {
  readonly username: string;
  readonly first_name: string;
  readonly last_name: string;
  readonly email: string;
}

/**
 * `UserAttributeSimilarityValidator(max_similarity=0.7)`.
 *
 * ```python
 * for attribute_name in ('username', 'first_name', 'last_name', 'email'):
 *     value = getattr(user, attribute_name, None)
 *     if not value or not isinstance(value, str): continue
 *     value_parts = re.split(r'\W+', value) + [value]
 *     for value_part in value_parts:
 *         if SequenceMatcher(a=password.lower(), b=value_part.lower()).quick_ratio() >= 0.7:
 *             raise ValidationError('The password is too similar to the %(verbose_name)s.')
 * ```
 *
 * `verbose_name` comes from the model field, so the four messages name `username`,
 * `first name`, `last name` and `email address`.
 */
const MAX_SIMILARITY = 0.7;

const ATTRIBUTES: readonly {
  key: keyof PasswordValidationSubject;
  verboseName: string;
}[] = [
  { key: 'username', verboseName: 'username' },
  { key: 'first_name', verboseName: 'first name' },
  { key: 'last_name', verboseName: 'last name' },
  { key: 'email', verboseName: 'email address' },
];

export function validateUserAttributeSimilarity(
  password: string,
  user: PasswordValidationSubject,
): string | null {
  for (const attribute of ATTRIBUTES) {
    const value = user[attribute.key];
    if (typeof value !== 'string' || value === '') {
      continue;
    }
    // `re.split(r'\W+', value) + [value]` — Python's `\W` is `[^a-zA-Z0-9_]` for a `str`
    // pattern without `re.UNICODE`… but Python 3 patterns are Unicode by default, so `\w`
    // includes accented letters. `\p{L}\p{N}_` is the JavaScript spelling of that.
    const parts = [...value.split(/[^\p{L}\p{N}_]+/u), value];
    for (const part of parts) {
      if (quickRatio(password.toLowerCase(), part.toLowerCase()) >= MAX_SIMILARITY) {
        return `The password is too similar to the ${attribute.verboseName}.`;
      }
    }
  }
  return null;
}

/** `NumericPasswordValidator` — `if password.isdigit()`. */
export function validateNotEntirelyNumeric(password: string): string | null {
  // CPython's `str.isdigit()` is Unicode-aware and false for the empty string.
  if (password.length > 0 && /^\p{Nd}+$/u.test(password)) {
    return 'This password is entirely numeric.';
  }
  return null;
}

/** `SetPasswordForm.clean_new_password2`, in v1's order: mismatch first, then the validators. */
export function validateNewPassword(
  password1: string,
  password2: string,
  user: PasswordValidationSubject,
): string[] {
  if (password1 !== password2) {
    // Django stops here: `raise ValidationError(self.error_messages['password_mismatch'])`
    // happens before `password_validation.validate_password` is reached.
    return ["The two password fields didn't match."];
  }
  // `validate_password` collects **every** failing validator's message, not just the first.
  const errors = [
    validateUserAttributeSimilarity(password2, user),
    validateNotEntirelyNumeric(password2),
  ].filter((message): message is string => message !== null);
  return errors;
}

/**
 * `difflib.SequenceMatcher.quick_ratio()` — an **upper bound** on `ratio()`, computed from a
 * multiset intersection rather than from matching blocks:
 *
 * ```python
 * fullbcount = Counter(b)
 * avail, matches = {}, 0
 * for elt in a:
 *     numb = avail[elt] if elt in avail else fullbcount.get(elt, 0)
 *     avail[elt] = numb - 1
 *     if numb > 0: matches += 1
 * return 2.0 * matches / (len(a) + len(b)) if (len(a) + len(b)) else 1.0
 * ```
 *
 * ⚠️ It is **not** `ratio()`, and the difference is observable: `quick_ratio` ignores order, so
 * `'olleh'` vs `'hello'` scores 1.0. Django calls `quick_ratio` and so must this — using
 * `ratio()` would accept passwords v1 rejects.
 *
 * Iteration is over **code points**, matching CPython's iteration over a `str`.
 */
export function quickRatio(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  const total = left.length + right.length;
  if (total === 0) {
    return 1;
  }
  const fullBCount = new Map<string, number>();
  for (const element of right) {
    fullBCount.set(element, (fullBCount.get(element) ?? 0) + 1);
  }
  const avail = new Map<string, number>();
  let matches = 0;
  for (const element of left) {
    const numb = avail.has(element)
      ? (avail.get(element) as number)
      : (fullBCount.get(element) ?? 0);
    avail.set(element, numb - 1);
    if (numb > 0) {
      matches += 1;
    }
  }
  return (2 * matches) / total;
}
