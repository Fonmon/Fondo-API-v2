import { Injectable, Logger } from '@nestjs/common';
import { DjangoPasswordService } from '../auth/password/django-password.service';
import { AppConfigService } from '../config/app-config.service';
import { EmailTemplate } from '../mail/email-template';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { UserService } from '../users/user.service';
import {
  PasswordResetTokenService,
  urlsafeBase64Decode,
  urlsafeBase64Encode,
  type ResetTokenSubject,
} from './password-reset-token.service';
import { validateNewPassword, type PasswordValidationSubject } from './password-validators';

/** The `auth_user` row the confirm pages work with. */
export interface ResetUser extends ResetTokenSubject, PasswordValidationSubject {
  readonly id: number;
}

/**
 * `fondo_api/views/auth.py:PasswordResetView.post` plus the parts of
 * `django.contrib.auth.views.PasswordResetConfirmView` that touch data.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UserService,
    private readonly mail: MailService,
    private readonly tokens: PasswordResetTokenService,
    private readonly passwords: DjangoPasswordService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * ```python
   * password_reset_form = PasswordResetForm(request.POST)
   * if password_reset_form.is_valid():
   *     data = password_reset_form.cleaned_data['email']
   *     user = user_service.get_user_by_email(data)
   *     if user != None:
   *         current_site = get_current_site(request)
   *         params = {
   *             'user': user,
   *             'protocol': 'https' if settings.ENVIRONMENT == 'production' else 'http',
   *             'domain': current_site.domain,
   *             'uid': urlsafe_base64_encode(force_bytes(user.pk)),
   *             'token': default_token_generator.make_token(user),
   *         }
   *         mail_service.send_mail(EmailTemplate.PASSWORD_RESET, [user.email], params)
   * return redirect("/password_reset/done/")
   * ```
   *
   * ⚠️ **`domain` is the `Host` header.** `django.contrib.sites` is not in `INSTALLED_APPS`
   * (`api/settings/base.py:26-36`), so `get_current_site` falls back to `RequestSite`, whose
   * `domain` is `request.get_host()`. That makes the emailed link's host attacker-controlled
   * unless `ALLOWED_HOSTS` is enforced — which is precisely why condition **C19** had to close
   * before this route shipped. `DjangoAllowedHostsMiddleware` has already validated the value
   * by the time it reaches here; a forged `Host` is a 400 several layers up.
   *
   * ⚠️ **The redirect is unconditional.** No email, an unknown address, an ambiguous one — all
   * end at `/password_reset/done/`, whose page says "if an account exists…". That is the
   * anti-enumeration property and it must not be "improved" into a 404.
   *
   * @returns nothing; the caller always redirects.
   */
  async requestReset(rawEmail: unknown, host: string): Promise<void> {
    const email = cleanEmail(rawEmail);
    if (email === null) {
      // `PasswordResetForm.is_valid()` is False for a missing or malformed address.
      return;
    }

    const user = await this.users.getUserByEmail(email);
    if (user === null) {
      return;
    }

    await this.mail.sendMail(EmailTemplate.PASSWORD_RESET, [user.email], {
      // `{{ user.get_username }}` in the Spanish template.
      username: user.username,
      protocol: this.config.environment === 'production' ? 'https' : 'http',
      domain: host,
      uid: urlsafeBase64Encode(String(user.id)),
      token: this.tokens.makeToken(user),
    });
  }

  /** `PasswordResetConfirmView.get_user(uidb64)` — `None` for a bad id, never an exception. */
  async getUserFromUidb64(uidb64: string): Promise<ResetUser | null> {
    const decoded = urlsafeBase64Decode(uidb64);
    if (decoded === null || !/^\d+$/.test(decoded)) {
      return null;
    }
    const id = Number(decoded);
    if (!Number.isSafeInteger(id) || id > 2147483647) {
      return null;
    }
    return this.prisma.authUser.findUnique({
      where: { id },
      select: {
        id: true,
        username: true,
        email: true,
        password: true,
        last_login: true,
        first_name: true,
        last_name: true,
      },
    });
  }

  checkToken(user: ResetUser | null, token: string | null | undefined): boolean {
    return this.tokens.checkToken(user, token);
  }

  /**
   * `SetPasswordForm` — validate, then `user.set_password(...)` and save.
   *
   * ⚠️ Django's `PasswordResetConfirmView.form_valid` calls `form.save()` and, with
   * `post_reset_login = False` (the default in 2.2), does **not** log the member in. So the
   * only side effect is the password column — which is also what makes the reset link
   * single-use, since the token is an HMAC over that column.
   *
   * @returns the validation errors; an empty array means the password was changed.
   */
  async setPassword(user: ResetUser, password1: string, password2: string): Promise<string[]> {
    const errors = validateNewPassword(password1, password2, user);
    if (errors.length > 0) {
      return errors;
    }
    await this.prisma.authUser.update({
      where: { id: user.id },
      data: { password: await this.passwords.hash(password2) },
    });
    this.logger.log(`Password reset completed for user ${user.id}`);
    return [];
  }
}

/**
 * `PasswordResetForm`'s single field: `email = forms.EmailField(max_length=254)`, required.
 *
 * Django's `EmailValidator` is more permissive than most: it accepts anything of the form
 * `local@domain` where the domain has a dot or is a literal. `is_valid()` being `False` simply
 * means no email is sent — the caller still redirects — so the exact boundary is not
 * observable to a client. Reproduced closely enough that no address v1 accepts is refused.
 */
function cleanEmail(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const email = value.trim();
  if (email.length === 0 || email.length > 254) {
    return null;
  }
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) {
    return null;
  }
  const domain = email.slice(at + 1);
  // `EmailValidator.domain_regex` requires a dotted name, a literal IP, or `localhost`.
  if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(domain) && domain !== 'localhost') {
    return null;
  }
  return email;
}
