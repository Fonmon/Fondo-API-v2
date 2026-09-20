import { DrfException } from '../../common/http/drf.exception';

/** The validated output of {@link parseAuthTokenRequest}. */
export interface AuthTokenCredentials {
  readonly username: string;
  readonly password: string;
}

/**
 * A field-for-field port of `rest_framework.authtoken.serializers.AuthTokenSerializer`
 * (DRF 3.11.2), which is what `POST /api-token-auth` validates against in v1:
 *
 * ```python
 * username = serializers.CharField(label=_("Username"))
 * password = serializers.CharField(label=_("Password"),
 *                                  style={'input_type': 'password'},
 *                                  trim_whitespace=False)
 * ```
 *
 * The differences between the two fields are observable and both matter:
 *  * `username` uses the default `trim_whitespace=True`, so `"  a@b.com  "` **logs in**
 *    and `"   "` is rejected as blank;
 *  * `password` sets `trim_whitespace=False`, so `"   "` is a candidate password (and fails
 *    as wrong credentials) while `""` is still rejected as blank.
 *
 * Every message and status below was captured from the pinned stack, not written from
 * memory — see `docs/phase-1-drf-auth-bodies.md`.
 */
export function parseAuthTokenRequest(body: unknown): AuthTokenCredentials {
  // `Serializer.to_internal_value`: a non-mapping payload is a non-field error naming the
  // Python type it actually got.
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw DrfException.validationError({
      non_field_errors: [`Invalid data. Expected a dictionary, but got ${pythonTypeName(body)}.`],
    });
  }

  const data = body as Record<string, unknown>;
  const errors: Record<string, string[]> = {};

  // Field declaration order decides key order in the rendered body: username, then password.
  const username = runCharField(data, 'username', true, errors);
  const password = runCharField(data, 'password', false, errors);

  if (Object.keys(errors).length > 0) {
    throw DrfException.validationError(errors);
  }

  // `AuthTokenSerializer.validate`'s `else` branch. Unreachable in practice — a field that
  // survived `run_validation` is a non-blank string, which is always truthy in Python — but
  // ported so the shape of the original is visible rather than silently dropped.
  if (!username || !password) {
    throw DrfException.validationError({
      non_field_errors: ['Must include "username" and "password".'],
    });
  }

  return { username: username, password: password };
}

/**
 * `CharField.run_validation` + `Field.validate_empty_values` + `CharField.to_internal_value`,
 * in DRF's order. Note that the blank check runs **before** the required/null checks, which
 * is why `run_validation` starts with it in the original.
 */
function runCharField(
  data: Record<string, unknown>,
  name: string,
  trimWhitespace: boolean,
  errors: Record<string, string[]>,
): string | undefined {
  const present = Object.prototype.hasOwnProperty.call(data, name);
  const raw = present ? data[name] : undefined;

  // `if data == '' or (self.trim_whitespace and str(data).strip() == ''): self.fail('blank')`
  // `empty` (missing) and `None` both fall through this check in Python.
  if (present && raw !== null) {
    if (raw === '' || (trimWhitespace && typeof raw === 'string' && raw.trim() === '')) {
      errors[name] = ['This field may not be blank.'];
      return undefined;
    }
  }

  // `Field.validate_empty_values`
  if (!present) {
    errors[name] = ['This field is required.'];
    return undefined;
  }
  if (raw === null) {
    errors[name] = ['This field may not be null.'];
    return undefined;
  }

  // `CharField.to_internal_value`: booleans and composites are rejected; numbers are
  // coerced with `str()`.
  if (typeof raw === 'boolean' || !(typeof raw === 'string' || typeof raw === 'number')) {
    errors[name] = ['Not a valid string.'];
    return undefined;
  }

  const value = typeof raw === 'string' ? raw : String(raw);
  return trimWhitespace ? value.trim() : value;
}

/** `type(data).__name__` for the values a JSON body can produce. */
function pythonTypeName(value: unknown): string {
  if (value === null) {
    return 'NoneType';
  }
  if (Array.isArray(value)) {
    return 'list';
  }
  switch (typeof value) {
    case 'string':
      return 'str';
    case 'boolean':
      return 'bool';
    case 'number':
      return Number.isInteger(value) ? 'int' : 'float';
    default:
      return typeof value;
  }
}
