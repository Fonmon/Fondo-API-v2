import { DrfException } from '../../common/http/drf.exception';
import { parseAuthTokenRequest } from './auth-token.serializer';

/**
 * Every expectation below was captured from `rest_framework.authtoken.serializers` running
 * under `djangorestframework==3.11.2` / `Django==2.2.27`. v1 has **no** test asserting any
 * of these bodies (`fondo_api/tests/` never posts a malformed login), so inventing them was
 * not an option.
 */
function expectValidationError(body: unknown, expected: Record<string, string[]>): void {
  try {
    parseAuthTokenRequest(body);
  } catch (error) {
    expect(error).toBeInstanceOf(DrfException);
    const drf = error as DrfException;
    expect(drf.getStatus()).toBe(400);
    expect(drf.drfBody).toEqual(expected);
    // Key order is part of the rendered body; DRF follows field declaration order.
    expect(Object.keys(drf.drfBody)).toEqual(Object.keys(expected));
    expect(drf.drfHeaders).toEqual({});
    return;
  }
  throw new Error('expected parseAuthTokenRequest to throw');
}

describe('AuthTokenSerializer port (rest_framework/authtoken/serializers.py)', () => {
  describe('valid payloads', () => {
    it('accepts a username and password', () => {
      expect(parseAuthTokenRequest({ username: 'a@b.com', password: 'password' })).toEqual({
        username: 'a@b.com',
        password: 'password',
      });
    });

    it('trims the username but not the password (trim_whitespace=False)', () => {
      // v1: `'  a@b.com  '` logs in; `' password '` does not match the stored hash.
      expect(parseAuthTokenRequest({ username: '  a@b.com  ', password: ' password ' })).toEqual({
        username: 'a@b.com',
        password: ' password ',
      });
    });

    it('accepts a whitespace-only password as a candidate (it simply will not match)', () => {
      expect(parseAuthTokenRequest({ username: 'a@b.com', password: '   ' })).toEqual({
        username: 'a@b.com',
        password: '   ',
      });
    });

    it('coerces numeric fields with str(), as CharField does', () => {
      expect(parseAuthTokenRequest({ username: 5, password: 1.5 })).toEqual({
        username: '5',
        password: '1.5',
      });
    });

    it('ignores unknown fields', () => {
      expect(
        parseAuthTokenRequest({ username: 'a@b.com', password: 'password', foo: 'bar' }),
      ).toEqual({ username: 'a@b.com', password: 'password' });
    });
  });

  describe('field errors', () => {
    it('reports both missing fields, username first', () => {
      expectValidationError(
        {},
        {
          username: ['This field is required.'],
          password: ['This field is required.'],
        },
      );
    });

    it('reports only the missing password', () => {
      expectValidationError({ username: 'a@b.com' }, { password: ['This field is required.'] });
    });

    it('reports only the missing username', () => {
      expectValidationError({ password: 'password' }, { username: ['This field is required.'] });
    });

    it('rejects a blank username', () => {
      expectValidationError(
        { username: '', password: 'password' },
        { username: ['This field may not be blank.'] },
      );
    });

    it('rejects a whitespace-only username (trim_whitespace=True makes it blank)', () => {
      expectValidationError(
        { username: '   ', password: 'password' },
        { username: ['This field may not be blank.'] },
      );
    });

    it('rejects a blank password', () => {
      expectValidationError(
        { username: 'a@b.com', password: '' },
        { password: ['This field may not be blank.'] },
      );
    });

    it('reports both blanks, username first', () => {
      expectValidationError(
        { username: '', password: '' },
        {
          username: ['This field may not be blank.'],
          password: ['This field may not be blank.'],
        },
      );
    });

    it('rejects null with a distinct message from missing', () => {
      expectValidationError(
        { username: null, password: 'password' },
        { username: ['This field may not be null.'] },
      );
      expectValidationError(
        { username: 'a@b.com', password: null },
        { password: ['This field may not be null.'] },
      );
    });

    it('rejects booleans and composites as not-a-string', () => {
      expectValidationError(
        { username: true, password: 'password' },
        { username: ['Not a valid string.'] },
      );
      expectValidationError(
        { username: ['a'], password: 'password' },
        { username: ['Not a valid string.'] },
      );
      expectValidationError(
        { username: { a: 1 }, password: 'password' },
        { username: ['Not a valid string.'] },
      );
    });
  });

  describe('non-dictionary payloads', () => {
    it('names the Python type it received', () => {
      expectValidationError([], {
        non_field_errors: ['Invalid data. Expected a dictionary, but got list.'],
      });
      expectValidationError('x', {
        non_field_errors: ['Invalid data. Expected a dictionary, but got str.'],
      });
      expectValidationError(null, {
        non_field_errors: ['Invalid data. Expected a dictionary, but got NoneType.'],
      });
      expectValidationError(7, {
        non_field_errors: ['Invalid data. Expected a dictionary, but got int.'],
      });
      expectValidationError(7.5, {
        non_field_errors: ['Invalid data. Expected a dictionary, but got float.'],
      });
      expectValidationError(true, {
        non_field_errors: ['Invalid data. Expected a dictionary, but got bool.'],
      });
    });
  });
});
