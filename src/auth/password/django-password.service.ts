import { randomInt, pbkdf2, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Injectable } from '@nestjs/common';

const pbkdf2Async = promisify(pbkdf2);

/**
 * Django 2.2's default password hasher, `PBKDF2PasswordHasher`.
 *
 * Real member passwords live in `auth_user.password` in the shared database, so v2 must
 * both **verify** and (while v1 still runs for parity testing) **write** this exact format.
 * Introducing argon2/bcrypt here would lock every existing member out of v1; rehash-on-login
 * is a post-cutover backlog item (`MIGRATION_PLAN.md` §9).
 *
 * Encoded form — four `$`-separated segments:
 *
 * ```
 * pbkdf2_sha256$150000$<12-char salt>$<base64 of 32 raw bytes>
 * ```
 *
 * Facts pinned against `Django==2.2.27` (`django/contrib/auth/hashers.py`):
 *  * `PBKDF2PasswordHasher.algorithm = 'pbkdf2_sha256'`, `digest = hashlib.sha256`,
 *    `iterations = 150000`.
 *  * `dklen` is `None`, so `hashlib.pbkdf2_hmac` returns the digest size, **32 bytes**.
 *  * `salt()` is `get_random_string()` → 12 characters drawn from
 *    `[a-zA-Z0-9]` ({@link SALT_ALPHABET}).
 *  * Password and salt are `force_bytes`-ed, i.e. **UTF-8**.
 *  * `is_password_usable()` — a password beginning with `!` (`UNUSABLE_PASSWORD_PREFIX`)
 *    can never match. Django gives such rows 40 random characters after the `!`.
 *
 * The whole `fondodev` database was checked: every one of the 15 `auth_user` rows is
 * `pbkdf2_sha256` at 150000 iterations. Django's `PASSWORD_HASHERS` default also lists
 * `pbkdf2_sha1`, `argon2` and `bcrypt_sha256`; none appear in the data, and v1 never writes
 * them, so {@link verify} rejects them rather than growing three more code paths that would
 * never be exercised. If one ever shows up, `verify` returns `false` — a login failure, not
 * a crash — and Phase 3's activation flow rewrites the row in the supported format.
 */
@Injectable()
export class DjangoPasswordService {
  /** `django.contrib.auth.hashers.PBKDF2PasswordHasher.algorithm`. */
  static readonly ALGORITHM = 'pbkdf2_sha256';
  /** `PBKDF2PasswordHasher.iterations` in Django 2.2 (2.1 used 120000; 3.0 uses 180000). */
  static readonly ITERATIONS = 150_000;
  /** `hashlib.sha256().digest_size` — `dklen=None` means "the digest size". */
  static readonly KEY_LENGTH = 32;
  /** `django.utils.crypto.get_random_string()` default length. */
  static readonly SALT_LENGTH = 12;

  /**
   * `django.contrib.auth.hashers.check_password(password, encoded)`.
   *
   * Returns `false` — never throws — for every malformed, unusable or unsupported hash, so
   * a corrupt row produces a normal "invalid credentials" login failure exactly as Django's
   * `identify_hasher` failure path does inside `ModelBackend.authenticate`.
   */
  async verify(password: string, encoded: string | null | undefined): Promise<boolean> {
    if (!encoded || encoded.startsWith(UNUSABLE_PASSWORD_PREFIX)) {
      // `is_password_usable()` is False -> `check_password` returns False immediately.
      return false;
    }

    const segments = encoded.split('$');
    if (segments.length !== 4) {
      return false;
    }
    const [algorithm, iterationsText, salt, expected] = segments;
    if (algorithm !== DjangoPasswordService.ALGORITHM) {
      return false;
    }

    const iterations = Number(iterationsText);
    if (!Number.isInteger(iterations) || iterations <= 0) {
      return false;
    }

    const actual = await this.derive(password, salt, iterations);
    const expectedBuffer = Buffer.from(expected, 'base64');
    const actualBuffer = Buffer.from(actual, 'base64');
    if (expectedBuffer.length !== actualBuffer.length) {
      return false;
    }
    // Django uses `hmac.compare_digest` (constant time); so do we.
    return timingSafeEqual(expectedBuffer, actualBuffer);
  }

  /**
   * `django.contrib.auth.hashers.make_password(password)` for the default hasher.
   *
   * `salt` is injectable so tests can pin Django's own output byte for byte; production
   * callers omit it and get a CSPRNG salt.
   */
  async hash(password: string, salt?: string): Promise<string> {
    const effectiveSalt = salt ?? this.salt();
    if (effectiveSalt.length === 0 || effectiveSalt.includes('$')) {
      // `PBKDF2PasswordHasher.encode` asserts exactly this.
      throw new Error('Django password salt must be non-empty and must not contain "$"');
    }
    const digest = await this.derive(password, effectiveSalt, DjangoPasswordService.ITERATIONS);
    return `${DjangoPasswordService.ALGORITHM}$${DjangoPasswordService.ITERATIONS}$${effectiveSalt}$${digest}`;
  }

  /**
   * `django.contrib.auth.hashers.make_password(None)` — the value
   * `UserManager._create_user` stores when it is given no password, via
   * `user.set_password(None)` → `set_unusable_password()`.
   *
   * That is exactly what `create_user` (`services/user.py:28-37`) produces: the member has
   * no password until they follow the activation link. The prefix is `!` and the suffix is
   * 40 random characters, which no hash can ever equal, so `verify` rejects it.
   *
   * v1's own test asserts on this shape — `assertFalse('pbkdf2_sha256' in user.password)`
   * before activation, `assertTrue(...)` after (`test_user_views.py:476-478`, `:506-508`).
   */
  unusablePassword(): string {
    let suffix = '';
    for (let i = 0; i < UNUSABLE_PASSWORD_SUFFIX_LENGTH; i += 1) {
      suffix += SALT_ALPHABET[randomInt(SALT_ALPHABET.length)];
    }
    return `${UNUSABLE_PASSWORD_PREFIX}${suffix}`;
  }

  /** `django.utils.crypto.get_random_string()` — 12 chars of `[a-zA-Z0-9]`, CSPRNG-backed. */
  salt(): string {
    let out = '';
    for (let i = 0; i < DjangoPasswordService.SALT_LENGTH; i += 1) {
      out += SALT_ALPHABET[randomInt(SALT_ALPHABET.length)];
    }
    return out;
  }

  private async derive(password: string, salt: string, iterations: number): Promise<string> {
    const key = await pbkdf2Async(
      Buffer.from(password, 'utf8'),
      Buffer.from(salt, 'utf8'),
      iterations,
      DjangoPasswordService.KEY_LENGTH,
      'sha256',
    );
    return key.toString('base64');
  }
}

/** `django.contrib.auth.hashers.UNUSABLE_PASSWORD_PREFIX`. */
const UNUSABLE_PASSWORD_PREFIX = '!';

/** `django.contrib.auth.hashers.UNUSABLE_PASSWORD_SUFFIX_LENGTH`. */
const UNUSABLE_PASSWORD_SUFFIX_LENGTH = 40;

/** `django.utils.crypto.get_random_string`'s default `allowed_chars`. */
const SALT_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
