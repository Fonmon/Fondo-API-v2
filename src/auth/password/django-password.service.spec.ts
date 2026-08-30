import { DjangoPasswordService } from './django-password.service';

/**
 * Golden vectors produced by `django.contrib.auth.hashers.make_password(...)` running under
 * `Django==2.2.27` (the version pinned in `~/Projects/Fondo-API/requirements.txt`), with the
 * salt passed explicitly so the output is reproducible.
 *
 * These are the contract: if v2 cannot reproduce them byte for byte, every existing member
 * is locked out at cutover, and a v2-written password would be unreadable by v1 during
 * parity testing.
 */
const DJANGO_VECTORS: readonly { password: string; salt: string; encoded: string }[] = [
  {
    password: 'password',
    salt: 'ZZZZZZZZZZZZ',
    encoded: 'pbkdf2_sha256$150000$ZZZZZZZZZZZZ$LSt3Vb2/DFqI0gPQAZEPkl1HxNF411J4KhMvgJX2cPo=',
  },
  {
    password: 's3cr3t!',
    salt: 'abcABC123xyz',
    encoded: 'pbkdf2_sha256$150000$abcABC123xyz$U7reEJyx3X37G9+iyiAIjWe/wVWBifdKO1Y8p479J1M=',
  },
  {
    // Non-ASCII: Django `force_bytes`es to UTF-8 before hashing.
    password: 'cóntraseña✓',
    salt: 'saltsaltsalt',
    encoded: 'pbkdf2_sha256$150000$saltsaltsalt$soa3iUjysTrIcEdzHHpy9Wf3wkhdQSvmZSZpztPf+C8=',
  },
  {
    password: '',
    salt: '0123456789ab',
    encoded: 'pbkdf2_sha256$150000$0123456789ab$ADRhW3sWt8VVslDZC0VVNBOmhxO8s/RRGw6CkDeH1cQ=',
  },
  {
    password: 'a'.repeat(200),
    salt: 'xyzXYZ098765',
    encoded: 'pbkdf2_sha256$150000$xyzXYZ098765$3/JE6UGyO5Mlp1riCiwRNEYE5TzwHu29LON+QfVBWks=',
  },
];

/**
 * A hash actually written by `UserProfile.objects.create_user(password='password')` in the
 * same Django run — i.e. the shape of a live `auth_user.password` row.
 */
const LIVE_ROW_HASH =
  'pbkdf2_sha256$150000$IcN4POfP8zno$dE8sG5SDDZYFHQNRreb7zFGtiLAXO1IXIA6zdem2w+A=';

describe('DjangoPasswordService (django.contrib.auth.hashers.PBKDF2PasswordHasher)', () => {
  const service = new DjangoPasswordService();

  describe('hash() reproduces Django byte for byte', () => {
    it.each(DJANGO_VECTORS.map((v) => [v.password.slice(0, 20), v.salt, v] as const))(
      'make_password(%p, salt=%p)',
      async (_label, _salt, vector) => {
        await expect(service.hash(vector.password, vector.salt)).resolves.toBe(vector.encoded);
      },
    );

    it('uses Django 2.2 defaults: pbkdf2_sha256, 150000 iterations, 12-char salt, 32-byte key', async () => {
      const encoded = await service.hash('anything');
      const [algorithm, iterations, salt, digest] = encoded.split('$');
      expect(algorithm).toBe('pbkdf2_sha256');
      expect(iterations).toBe('150000');
      expect(salt).toHaveLength(12);
      expect(salt).toMatch(/^[a-zA-Z0-9]{12}$/);
      expect(Buffer.from(digest, 'base64')).toHaveLength(32);
    });

    it('produces a different salt every call', async () => {
      const salts = await Promise.all(
        Array.from({ length: 8 }, async () => (await service.hash('x')).split('$')[2]),
      );
      expect(new Set(salts).size).toBe(8);
    });

    it('rejects a salt containing "$" — Django asserts the same', async () => {
      await expect(service.hash('x', 'bad$salt')).rejects.toThrow(/must not contain/);
      await expect(service.hash('x', '')).rejects.toThrow(/non-empty/);
    });
  });

  describe('verify() reproduces check_password', () => {
    it.each(DJANGO_VECTORS.map((v) => [v.salt, v] as const))(
      'accepts the correct password for salt %p',
      async (_salt, vector) => {
        await expect(service.verify(vector.password, vector.encoded)).resolves.toBe(true);
      },
    );

    it('accepts a hash written by Django create_user()', async () => {
      await expect(service.verify('password', LIVE_ROW_HASH)).resolves.toBe(true);
    });

    it('rejects the wrong password', async () => {
      await expect(service.verify('Password', LIVE_ROW_HASH)).resolves.toBe(false);
      await expect(service.verify('', LIVE_ROW_HASH)).resolves.toBe(false);
      await expect(service.verify('password ', LIVE_ROW_HASH)).resolves.toBe(false);
    });

    it('round-trips its own output', async () => {
      const encoded = await service.hash('a-fresh-password');
      await expect(service.verify('a-fresh-password', encoded)).resolves.toBe(true);
      await expect(service.verify('a-fresh-passwore', encoded)).resolves.toBe(false);
    });

    it('returns false — never throws — for unusable passwords', async () => {
      // `make_password(None)` -> '!' + 40 random chars. `is_password_usable` is False, so
      // Django's check_password short-circuits to False.
      await expect(
        service.verify('anything', '!BVIdQWBE4TrOHhqSW15yX9AeFnelJ8bBJqX0ZbXX'),
      ).resolves.toBe(false);
    });

    it('returns false — never throws — for malformed or foreign hashes', async () => {
      const bad = [
        '',
        null,
        undefined,
        'not-a-hash',
        'pbkdf2_sha256$150000$onlythree',
        'pbkdf2_sha256$notanumber$salt$aGFzaA==',
        'pbkdf2_sha256$0$salt$aGFzaA==',
        // Other hashers in Django's default PASSWORD_HASHERS list. None appear in fondodev;
        // rejecting them is a login failure, not a crash.
        'pbkdf2_sha1$150000$salt$aGFzaA==',
        'argon2$argon2i$v=19$m=512,t=2,p=2$c2FsdA$aGFzaA',
        'bcrypt_sha256$$2b$12$saltsaltsaltsaltsaltuO',
      ];
      for (const encoded of bad) {
        await expect(service.verify('password', encoded)).resolves.toBe(false);
      }
    });

    it('rejects a digest of the wrong length without throwing on timingSafeEqual', async () => {
      await expect(service.verify('password', 'pbkdf2_sha256$150000$salt$aGk=')).resolves.toBe(
        false,
      );
    });
  });
});
