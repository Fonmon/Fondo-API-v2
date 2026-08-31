import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { Eta } from 'eta';
import { AppConfigService } from '../config/app-config.service';
import {
  EMAIL_TEMPLATE_FILES,
  EmailTemplate,
  type EmailTemplateParams,
  type RenderedEmail,
  type TemplateValue,
} from './email-template';

/**
 * The Node replacement for `django.template.loader.render_to_string`.
 *
 * ## What the six templates actually use
 *
 * Every one of v1's email templates is wrapped in `{% autoescape off %}` … `{% endautoescape %}`
 * and contains nothing but literal text and `{{ variable }}` interpolations — no loops, no
 * conditionals, no filters. So the entire Django feature surface in play is:
 *
 *  1. **No HTML escaping.** `autoescape off` is required: `{{loan_table}}` is a whole
 *     `<table>` of amortization rows and `{{host_url}}` contains `//`.
 *  2. **`str()` coercion** of every value, including `None` → the literal text `None`.
 *  3. **A missing variable renders as the empty string** (`string_if_invalid`, default `''`).
 *
 * Eta is configured with `autoEscape: false` for (1); (2) and (3) are handled here in
 * {@link djangoContext} rather than in the templates, so the `.eta` files stay a
 * character-for-character mirror of the `.html` ones.
 *
 * ## The `{% host %}` tag
 *
 * `fondo_api/templatetags/env_var.py` registers `{% host %}` → `os.environ.get('HOST_URL_APP')`.
 * ⚠️ **No template in v1 calls it** — the activation email takes the same value as an ordinary
 * `host_url` context variable instead (`services/user.py:51`). It is nevertheless exposed here
 * as the ambient `it.host` variable so the tag has a v2 equivalent if a template ever starts
 * using it, and so the config dependency is visible rather than latent.
 *
 * ## Whitespace is part of the contract
 *
 * v1's tests assert the rendered HTML **byte for byte**, leading `\n` and trailing `\n\n`
 * included, and the `.txt` subjects carry **no trailing newline** — a subject rendered as
 * `'[Fondo Montañez] Test email\n'` is a parity break. `email-template.renderer.spec.ts`
 * pins all six against strings captured from a real `Django==2.2.27` render, so an editor
 * that "helpfully" adds a final newline fails the build.
 */
@Injectable()
export class EmailTemplateRenderer {
  /**
   * Resolved from `__dirname` so it works both from `src` (ts-jest) and from `dist`
   * (`nest build`, which copies `mail/templates/**` via `nest-cli.json`'s `assets`).
   */
  private readonly templateRoot = join(__dirname, 'templates');

  private readonly eta = new Eta({
    views: this.templateRoot,
    // `{% autoescape off %}` — the loan table and the activation link are raw HTML.
    autoEscape: false,
    // Django's renderer does not trim; neither may this one.
    autoTrim: false,
    rmWhitespace: false,
    cache: true,
  });

  /** Subjects are static files with no interpolation; read once, then memoised. */
  private readonly subjectCache = new Map<string, string>();

  constructor(private readonly config: AppConfigService) {}

  /**
   * `MailService.__get_email_from_template(template, params)`.
   *
   * @throws Error when `template` is not one of the six. v1 would have handed SES a `None`
   *   body and let its bare `except` turn that into `False`; the throw here reaches
   *   `MailService.sendMail`'s catch and produces the same `false`, with a usable message.
   */
  render<T extends EmailTemplate>(template: T, params: EmailTemplateParams[T]): RenderedEmail {
    const files = EMAIL_TEMPLATE_FILES[template];
    if (files === undefined) {
      throw new Error(`Unknown email template: ${String(template)}`);
    }

    const body = this.eta.render(files.body, djangoContext(params, this.config.hostUrlApp));
    return { body, subject: this.subject(files.subject) };
  }

  private subject(file: string): string {
    const cached = this.subjectCache.get(file);
    if (cached !== undefined) {
      return cached;
    }
    // `render_to_string('…/x_subject.txt')` on a template with no tags is the file verbatim.
    const text = readFileSync(join(this.templateRoot, file), 'utf8');
    this.subjectCache.set(file, text);
    return text;
  }
}

/**
 * Applies Django's two rendering rules to the context before Eta ever sees it, so every
 * value the template interpolates is already the exact string Django would have produced.
 *
 *  * **`str()` coercion** — `1` → `'1'`, `None` → `'None'`, `True` → `'True'`.
 *    ⚠️ `None` really does render as the four characters `None`; verified against
 *    `Django==2.2.27`. The typed `EmailTemplateParams` make it hard to hit by accident, but
 *    the coercion is reproduced rather than "fixed" so a `null` behaves identically in both
 *    systems.
 *  * **Unknown names render empty** — `string_if_invalid` defaults to `''`. A `Proxy` supplies
 *    that for any key the caller omitted; without it Eta would emit the literal text
 *    `undefined` into a member's email.
 */
function djangoContext(
  params: Record<string, TemplateValue> | undefined,
  host: string,
): Record<string, string> {
  const coerced: Record<string, string> = { host };
  for (const [key, value] of Object.entries(params ?? {})) {
    coerced[key] = djangoStr(value);
  }
  return new Proxy(coerced, {
    get(target, property): string {
      if (typeof property !== 'string') {
        return '';
      }
      return Object.prototype.hasOwnProperty.call(target, property) ? target[property] : '';
    },
  });
}

/** Python's `str()` for the value shapes a template context can carry. */
function djangoStr(value: TemplateValue): string {
  if (value === null) {
    return 'None';
  }
  if (typeof value === 'boolean') {
    return value ? 'True' : 'False';
  }
  return String(value);
}
