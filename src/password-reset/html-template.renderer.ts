import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { Eta } from 'eta';
import { AppConfigService } from '../config/app-config.service';

/**
 * The four `django.contrib.auth` password-reset pages plus Django's CSRF failure page.
 *
 * ⚠️ **Every `.eta` file in `templates/` was produced by running the real templates through
 * `Django==2.2.27` inside the v1 image and substituting only the values that vary** — the CSRF
 * token, `{% host %}`, and the two branches of `{% if validlink %}`. Nothing was retyped, and
 * the whitespace (tabs mixed with spaces, the empty lines Django's `{% block %}` and
 * `{% load %}` tags leave behind) is byte-identical because it is the original output. A
 * "tidied" template is a parity failure.
 *
 * `{% static "x" %}` is already resolved to `/static/x`: `STATIC_URL = '/static/'` and no
 * hashing storage is configured. ⚠️ Those files are **not served** — `staticfiles` does not
 * serve with `DEBUG = False` and there is no `/static/` pattern in the URL conf — so the
 * pages render unstyled in v1 too. Ported as-is rather than "fixed".
 */
@Injectable()
export class PasswordResetHtmlRenderer {
  private readonly eta = new Eta({
    views: join(__dirname, 'templates'),
    // Django's `autoescape` is on for these pages, but every interpolation here is either
    // already-escaped HTML the caller built (`<%~ %>`) or a token from `[a-zA-Z0-9]`.
    autoEscape: false,
    autoTrim: false,
    rmWhitespace: false,
    cache: true,
  });

  constructor(private readonly config: AppConfigService) {}

  render(template: string, context: Record<string, string> = {}): string {
    return this.eta.render(template, { host: this.config.hostUrlApp, ...context });
  }
}

/**
 * `django.utils.html.escape` — `django.utils.html._html_escapes`, applied by
 * `conditional_escape` when a template renders `{{ field.errors }}`.
 *
 * The apostrophe is `&#39;`, not `&apos;`: "The two password fields didn&#39;t match." is the
 * exact string v1 emits.
 */
export function djangoEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * The `{% if form.errors %}{% for field in form %}…{% endfor %}{% endif %}` block of
 * `password_reset_confirm.html`, rendered exactly as Django renders it.
 *
 * Both strings below were lifted from real renders — the empty case from a fresh
 * `SetPasswordForm`, the populated one from a bound form with a mismatch — so the tab/space
 * mixture and the blank lines the template tags leave behind are the originals.
 *
 * ⚠️ Only two shapes are possible and that is a property of the form, not an assumption:
 * `SetPasswordForm` has exactly two fields and `clean_new_password2` attaches **every** error
 * to `new_password2`, so `new_password1` never has one.
 */
export function renderFieldErrors(errors: readonly string[]): string {
  if (errors.length === 0) {
    return '                \n';
  }
  const items = errors.map((message) => `<li>${djangoEscape(message)}</li>`).join('');
  return (
    '                \n' +
    '                    \n' +
    '                        \n' +
    '                    \n' +
    '                        \n' +
    `                            <div class="alert alert-danger"><ul class="errorlist">${items}</ul></div>\n` +
    '                        \n' +
    '                    \n' +
    '                \n'
  );
}
