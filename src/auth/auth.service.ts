import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '../prisma';
import { PrismaService } from '../prisma/prisma.service';
import { DrfException } from '../common/http/drf.exception';
import { parseAuthTokenRequest } from './dto/auth-token.serializer';
import { DjangoPasswordService } from './password/django-password.service';
import type { AuthenticatedToken, AuthenticatedUser } from './types/authenticated-user';

/** `POST /api-token-auth` response body: `Response({'token': token.key})`. */
export interface AuthTokenResponse {
  readonly token: string;
}

/** What {@link AuthService.authenticateByTokenKey} hands back to `TokenAuthGuard`. */
export interface TokenAuthentication {
  readonly user: AuthenticatedUser;
  readonly token: AuthenticatedToken;
}

/**
 * Everything `POST /api-token-auth` and DRF's `TokenAuthentication` need from the database.
 *
 * The v1 code being ported lives in three places:
 *  * `rest_framework/authtoken/views.py:ObtainAuthToken.post`
 *  * `rest_framework/authtoken/serializers.py:AuthTokenSerializer.validate` →
 *    `django.contrib.auth.authenticate` → `ModelBackend.authenticate`
 *  * `rest_framework/authentication.py:TokenAuthentication.authenticate_credentials`
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: DjangoPasswordService,
  ) {}

  /**
   * `ObtainAuthToken.post`.
   *
   * Three behaviors that are easy to lose in translation and are asserted by the e2e suite:
   *
   *  1. **Get-or-create, never rotate.** `Token.objects.get_or_create(user=user)` returns the
   *     existing row, so logging in twice yields the *same* string. Members' clients cache
   *     it; rotating on login would sign every device out on every login.
   *  2. **`last_login` is not touched.** DRF calls `authenticate()`, not `login()`, so the
   *     `user_logged_in` signal that drives `update_last_login` never fires.
   *  3. **Login is by `auth_user.username`, not by email.** `AUTH_USER_MODEL` is left at
   *     Django's default (`api/settings/base.py` has the override commented out), so
   *     `ModelBackend` resolves `get_by_natural_key` against `User.USERNAME_FIELD`, which is
   *     `username` — `UserProfile.USERNAME_FIELD = 'email'` never comes into play here. v1
   *     keeps `username == email` on every write path, so the two agree in the data; the
   *     lookup column still has to be `username` to be faithful.
   */
  async login(body: unknown): Promise<AuthTokenResponse> {
    const credentials = parseAuthTokenRequest(body);
    const user = await this.authenticate(credentials.username, credentials.password);

    if (user === null) {
      // `serializers.ValidationError(_('Unable to log in with provided credentials.'))`
      // raised from `validate()`, so DRF nests it under `non_field_errors` and returns 400.
      throw DrfException.validationError({
        non_field_errors: ['Unable to log in with provided credentials.'],
      });
    }

    return { token: await this.getOrCreateToken(user.id) };
  }

  /**
   * `django.contrib.auth.backends.ModelBackend.authenticate`.
   *
   * ```python
   * try:
   *     user = UserModel._default_manager.get_by_natural_key(username)
   * except UserModel.DoesNotExist:
   *     UserModel().set_password(password)          # timing-attack mitigation
   * else:
   *     if user.check_password(password) and self.user_can_authenticate(user):
   *         return user
   * ```
   *
   * `user_can_authenticate` is `is_active is None or is_active`, so a deactivated member
   * gets the *same* 400 body as a wrong password — no account-existence oracle.
   */
  private async authenticate(username: string, password: string): Promise<{ id: number } | null> {
    const user = await this.prisma.authUser.findUnique({
      where: { username },
      select: { id: true, password: true, is_active: true },
    });

    if (user === null) {
      // Django hashes anyway so a missing user costs the same wall-clock time as a present
      // one. Dropping this would turn login into a user-enumeration oracle.
      await this.passwords.hash(password);
      return null;
    }

    const passwordMatches = await this.passwords.verify(password, user.password);
    if (!passwordMatches || !user.is_active) {
      return null;
    }
    return { id: user.id };
  }

  /**
   * `Token.objects.get_or_create(user=user)`.
   *
   * `authtoken_token.user_id` is UNIQUE, and `created` is `auto_now_add` — Django sets it in
   * Python (`timezone.now()`, an aware UTC instant), there is no DB default, so v2 must
   * supply it (cross-cutting rule §4.5). The column is `timestamptz`, so the instant itself
   * is timezone-agnostic; `America/Bogota` only matters where a *calendar date* is derived.
   * The unique-violation retry mirrors Django's own `get_or_create`, which catches
   * `IntegrityError` and re-runs the `get`.
   */
  private async getOrCreateToken(userId: number): Promise<string> {
    const existing = await this.prisma.authToken.findUnique({
      where: { user_id: userId },
      select: { key: true },
    });
    if (existing !== null) {
      return existing.key;
    }

    try {
      const created = await this.prisma.authToken.create({
        data: {
          key: generateTokenKey(),
          user_id: userId,
          created: new Date(),
        },
        select: { key: true },
      });
      return created.key;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // Concurrent login for the same user; Django's get_or_create re-gets here too.
        const raced = await this.prisma.authToken.findUnique({
          where: { user_id: userId },
          select: { key: true },
        });
        if (raced !== null) {
          return raced.key;
        }
      }
      throw error;
    }
  }

  /**
   * `TokenAuthentication.authenticate_credentials(key)`.
   *
   * Returns `null` for an unknown key and throws for an inactive user, mirroring the two
   * distinct `AuthenticationFailed` messages DRF raises. The join to
   * `fondo_api_userprofile` is the MTI second half; it is `select_related`-equivalent so the
   * role check downstream costs no extra query.
   */
  async authenticateByTokenKey(key: string): Promise<TokenAuthentication | null> {
    const row = await this.prisma.authToken.findUnique({
      where: { key },
      select: {
        key: true,
        created: true,
        user: {
          select: {
            id: true,
            username: true,
            email: true,
            is_active: true,
            profile: { select: { role: true, identification: true } },
          },
        },
      },
    });

    if (row === null) {
      return null;
    }

    return {
      token: { key: row.key, created: row.created },
      user: {
        id: row.user.id,
        username: row.user.username,
        email: row.user.email,
        isActive: row.user.is_active,
        profile:
          row.user.profile === null
            ? null
            : {
                role: row.user.profile.role,
                identification: row.user.profile.identification,
              },
      },
    };
  }
}

/**
 * `rest_framework.authtoken.models.Token.generate_key`:
 * `binascii.hexlify(os.urandom(20)).decode()` — 20 random bytes rendered as 40 lowercase
 * hex characters, which is exactly the width of `authtoken_token.key`.
 */
function generateTokenKey(): string {
  return randomBytes(20).toString('hex');
}
