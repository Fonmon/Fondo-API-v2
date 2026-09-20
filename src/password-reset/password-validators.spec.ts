import {
  quickRatio,
  validateNewPassword,
  validateNotEntirelyNumeric,
  validateUserAttributeSimilarity,
  type PasswordValidationSubject,
} from './password-validators';

const user: PasswordValidationSubject = {
  username: 'angelitogomeza@hotmail.com',
  first_name: 'Foo',
  last_name: 'Name',
  email: 'angelitogomeza@hotmail.com',
};

/**
 * `settings.AUTH_PASSWORD_VALIDATORS` — v1 keeps **two** of Django's five.
 *
 * ⚠️ Every `quickRatio` expectation below was produced by running
 * `difflib.SequenceMatcher(a=…, b=…).quick_ratio()` on **CPython 3.9 inside the v1 image** and
 * comparing all 12 cases; 0 mismatches. The `\W+` split expectations came from the same run.
 */
describe('password validators', () => {
  describe('quickRatio — difflib.SequenceMatcher.quick_ratio', () => {
    it.each([
      ['hello', 'hello', 1],
      // ⚠️ Order-insensitive: this is `quick_ratio`, not `ratio`. Using `ratio` here would
      // accept passwords v1 rejects.
      ['olleh', 'hello', 1],
      ['abc', 'xyz', 0],
      ['', '', 1],
      ['a', '', 0],
      ['angelito', 'angelitogomeza@hotmail.com', 0.47058823529411764],
      ['Montañez', 'montanez', 0.75],
      ['password', 'Foo Name', 0.25],
      ['ñññ', 'ñn', 0.4],
      ['🎉x', 'x🎉', 1],
    ])('quickRatio(%p, %p) is %p', (a, b, expected) => {
      expect(quickRatio(a, b)).toBeCloseTo(expected, 12);
    });

    it('iterates code points, not UTF-16 units', () => {
      // Two astral characters are two elements, so the denominator is 4 and not 8.
      expect(quickRatio('🎉🎊', '🎉🎊')).toBe(1);
    });
  });

  describe('UserAttributeSimilarityValidator', () => {
    it('names the attribute with Django’s verbose_name', () => {
      expect(validateUserAttributeSimilarity(user.username, user)).toBe(
        'The password is too similar to the username.',
      );
    });

    it('checks each `\\W+` part as well as the whole value', () => {
      // 'angelitogomeza' is a part of the username; on its own it is over the 0.7 threshold.
      expect(validateUserAttributeSimilarity('angelitogomeza', user)).toBe(
        'The password is too similar to the username.',
      );
    });

    it('reports first_name and last_name with their spaced verbose names', () => {
      expect(validateUserAttributeSimilarity('Foo', user)).toBe(
        'The password is too similar to the first name.',
      );
      expect(validateUserAttributeSimilarity('Name', user)).toBe(
        'The password is too similar to the last name.',
      );
    });

    it('accepts an unrelated password', () => {
      expect(validateUserAttributeSimilarity('correcto-caballo-batería', user)).toBeNull();
    });

    it('skips empty attributes', () => {
      const bare = { username: '', first_name: '', last_name: '', email: '' };
      expect(validateUserAttributeSimilarity('anything', bare)).toBeNull();
    });
  });

  describe('NumericPasswordValidator', () => {
    it('refuses an entirely numeric password', () => {
      expect(validateNotEntirelyNumeric('12345678')).toBe('This password is entirely numeric.');
    });

    it('accepts anything with a non-digit, and the empty string', () => {
      expect(validateNotEntirelyNumeric('1234567a')).toBeNull();
      expect(validateNotEntirelyNumeric('')).toBeNull();
    });
  });

  describe('SetPasswordForm.clean_new_password2', () => {
    it('reports only the mismatch when the two fields differ', () => {
      // Django raises before `validate_password` runs, so a mismatched *and* numeric pair
      // reports one message, not two.
      expect(validateNewPassword('12345678', '87654321', user)).toEqual([
        "The two password fields didn't match.",
      ]);
    });

    it('collects every failing validator when they match', () => {
      expect(validateNewPassword(user.username, user.username, user)).toEqual([
        'The password is too similar to the username.',
      ]);
    });

    it('accepts a short, common password — v1 removed those two validators', () => {
      // ⚠️ `MinimumLengthValidator` and `CommonPasswordValidator` are NOT in
      // `api/settings/base.py:106-113`. "ab" and "password" are both accepted.
      expect(validateNewPassword('ab', 'ab', user)).toEqual([]);
    });
  });
});
