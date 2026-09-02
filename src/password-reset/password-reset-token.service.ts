import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';

/** The `auth_user` columns a reset token is bound to. */
export interface ResetTokenSubject {
  readonly id: number;
  readonly password: string;
  readonly last_login: Date | null;
}

/**
 * v2's password-reset token — **its own scheme**, deliberately, and the plan says so
 * (Phase 3: "v2 uses its **own** token scheme — no need to reimplement Django's
 * `default_token_generator` or share `DJANGO_SECRET_KEY`").
 *
 * Cutover is a hard switch, so no v2 token ever has to be checked by v1 or vice versa. The
 * only cost is that links v1 issued stop working at the switch; Django's timeout is 3 days, so
 * at worst a few members re-request. That is already in the plan's runbook.
 *
 * ## What is copied from Django, and why each part is not optional
 *
 * The **shape** is copied — `<base36 timestamp>-<20 hex chars>` — because
 * `api/urls.py:24` constrains the URL segment to `[0-9A-Za-z]{1,13}-[0-9A-Za-z]{1,20}`, and
 * that pattern is transcribed in `django-url-conf.ts` as part of the contract. A token that
 * does not match it would 404 at the resolver.
 *
 * The **inputs** are copied, and they are what make the token single-use without any storage:
 *
 * | input | what it buys |
 * |---|---|
 * | `user.id` | binds the token to one account |
 * | `user.password` | the hash changes when the reset completes, so the link dies on use |
 * | `user.last_login` | a login after the link was issued also invalidates it |
 * | the timestamp | expiry, checked against `PASSWORD_RESET_TIMEOUT_DAYS = 3` |
 *
 * Dropping the password would give a link that works for ever and can be replayed. Dropping
 * the timestamp would remove expiry entirely. Neither is a simplification.
 *
 * The **algorithm** is not copied: Django 2.2 uses salted SHA-1, v2 uses HMAC-SHA-256 and
 * keeps 20 hex characters (80 bits) of it. No compatibility is lost because none is needed.
 */
@Injectable()
export class PasswordResetTokenService {
  /** `settings.PASSWORD_RESET_TIMEOUT_DAYS` — Django 2.2's default. */
  static readonly TIMEOUT_DAYS = 3;

  /** `PasswordResetTokenGenerator.key_salt`, in spirit: domain separation for the HMAC. */
  private static readonly KEY_SALT = 'fondo-api-v2.password-reset-token';

  private static readonly HASH_LENGTH = 20;

  constructor(private readonly config: AppConfigService) {}

  /** `default_token_generator.make_token(user)`. */
  makeToken(user: ResetTokenSubject, now: Date = new Date()): string {
    const timestamp = Math.floor(now.getTime() / 1000);
    return `${timestamp.toString(36)}-${this.hash(user, timestamp)}`;
  }

  /**
   * `default_token_generator.check_token(user, token)`.
   *
   * Returns `false` — never throws — for a malformed token, a token for another user, a token
   * whose account has since changed its password or logged in, and a token older than
   * {@link TIMEOUT_DAYS}. A caller must not be able to tell those apart: Django's own view
   * renders the same "invalid or already used" page for all of them.
   */
  checkToken(
    user: ResetTokenSubject | null,
    token: string | null | undefined,
    now: Date = new Date(),
  ): boolean {
    if (user === null || token === null || token === undefined) {
      return false;
    }
    const separator = token.indexOf('-');
    if (separator <= 0) {
      return false;
    }
    const timestampPart = token.slice(0, separator);
    if (!/^[0-9a-z]{1,13}$/.test(timestampPart)) {
      return false;
    }
    const timestamp = Number.parseInt(timestampPart, 36);
    if (!Number.isFinite(timestamp)) {
      return false;
    }

    const expected = this.hash(user, timestamp);
    const provided = token.slice(separator + 1);
    if (provided.length !== expected.length) {
      return false;
    }
    if (!timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'))) {
      return false;
    }

    const ageSeconds = Math.floor(now.getTime() / 1000) - timestamp;
    return ageSeconds >= 0 && ageSeconds <= PasswordResetTokenService.TIMEOUT_DAYS * 86400;
  }

  private hash(user: ResetTokenSubject, timestamp: number): string {
    const lastLogin = user.last_login === null ? '' : user.last_login.toISOString();
    return createHmac('sha256', `${PasswordResetTokenService.KEY_SALT}${this.config.secretKey}`)
      .update(`${user.id}${user.password}${lastLogin}${timestamp}`)
      .digest('hex')
      .slice(0, PasswordResetTokenService.HASH_LENGTH);
  }
}

/**
 * `django.utils.http.urlsafe_base64_encode(force_bytes(user.pk))` — base64url of the **decimal
 * string**, unpadded. User 7 becomes `Nw`.
 *
 * Ported verbatim rather than replaced by the bare id, because `api/urls.py:24` constrains the
 * segment to `[0-9A-Za-z_\-]+` and because a link's shape is the one part of the reset flow a
 * member actually sees.
 */
export function urlsafeBase64Encode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/** `urlsafe_base64_decode`, returning `null` where Django raises (the caller answers 404). */
export function urlsafeBase64Decode(value: string): string | null {
  if (!/^[0-9A-Za-z_-]+$/.test(value)) {
    return null;
  }
  try {
    return Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}
