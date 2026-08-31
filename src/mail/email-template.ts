/**
 * `fondo_api/enums.py:EmailTemplate`, with the same members and the same integer values.
 *
 * The values never reach the wire — v1 compares enum members, not numbers — but keeping
 * them identical makes the two files diffable, and a future log line or database column
 * that records "which email did we send" will agree across the cutover.
 */
export enum EmailTemplate {
  USER_ACTIVATION = 1,
  CHANGE_STATE_LOAN_APPROVED = 2,
  CHANGE_STATE_LOAN_DENIED = 3,
  POWER_APPROVED = 4,
  TEST = 5,
  PASSWORD_RESET = 6,
}

/**
 * A value a Django template may interpolate. Django renders it with `str()`, so an `int`
 * and a `str` are interchangeable — `{{loan_id}}` is fed `loan.id` (an int) in
 * `services/loan.py:88` and `'1'` would render identically.
 *
 * `bigint` is included because the money and identification columns are `BigInt` in Prisma
 * (`requester_identification` in the power-of-attorney letter is one of them).
 */
export type TemplateValue = string | number | bigint | boolean | null;

/**
 * The context each template needs, transcribed from its v1 call site.
 *
 * These are what makes `MailService.sendMail` type-safe: Phase 3 cannot send a
 * `USER_ACTIVATION` email without `user_key`, and cannot misspell `host_url` into a silently
 * blank link — which is exactly what Django would do, because its default `string_if_invalid`
 * is the empty string.
 */
export interface EmailTemplateParams {
  /** `fondo_api/services/user.py:47-52` (`create_user`). */
  [EmailTemplate.USER_ACTIVATION]: {
    user_full_name: TemplateValue;
    user_id: TemplateValue;
    user_key: TemplateValue;
    host_url: TemplateValue;
  };
  /** `fondo_api/services/loan.py:87-96` (`update_loan`, `state == 1`). */
  [EmailTemplate.CHANGE_STATE_LOAN_APPROVED]: {
    loan_id: TemplateValue;
    /** The pre-rendered amortization table HTML. Interpolated **unescaped**. */
    loan_table: TemplateValue;
  };
  /** `fondo_api/services/loan.py:87-88` (`update_loan`, `state == 2`). */
  [EmailTemplate.CHANGE_STATE_LOAN_DENIED]: {
    loan_id: TemplateValue;
  };
  /** `fondo_api/services/user.py:196-204` (`handle_power_request`, approval). */
  [EmailTemplate.POWER_APPROVED]: {
    requester_full_name: TemplateValue;
    requester_identification: TemplateValue;
    requestee_full_name: TemplateValue;
    requestee_identification: TemplateValue;
    /** Already formatted Spanish date — `format_date(..., locale='es')` at the call site. */
    meeting_date: TemplateValue;
  };
  /**
   * `fondo_api/services/admin.py:10` passes `None`; `render_to_string('test/test_email.html')`
   * is called without a context at all, so the template has no variables.
   */
  [EmailTemplate.TEST]: undefined;
  /**
   * `fondo_api/views/auth.py:36-46`. Flattened from v1's context:
   *  * `user.get_username` → {@link username}
   *  * `{% url 'password_reset_confirm' uidb64=uid token=token %}` → `/reset/<uid>/<token>/`,
   *    which is the path `api/urls.py` maps that name to.
   */
  [EmailTemplate.PASSWORD_RESET]: {
    username: TemplateValue;
    protocol: TemplateValue;
    domain: TemplateValue;
    uid: TemplateValue;
    token: TemplateValue;
  };
}

/** The rendered pair `MailService.__get_email_from_template` returns. */
export interface RenderedEmail {
  readonly body: string;
  readonly subject: string;
}

/**
 * `MailService.__get_email_from_template`'s if/elif chain, as data.
 *
 * v1's chain has no `else`: an unknown template leaves `{'body': None, 'subject': None}` and
 * SES then raises on the `None` — which `send_mail`'s bare `except` swallows into a `False`.
 * v2 makes the same case a lookup miss and {@link EmailTemplateRenderer} throws, which
 * `MailService.sendMail` catches into the same `false`. Same observable outcome, but the
 * cause is logged instead of arriving as a botocore parameter-validation error.
 */
export const EMAIL_TEMPLATE_FILES: Readonly<
  Record<EmailTemplate, { readonly body: string; readonly subject: string }>
> = Object.freeze({
  [EmailTemplate.USER_ACTIVATION]: {
    body: 'activation/activation_email.eta',
    subject: 'activation/activation_subject.txt',
  },
  [EmailTemplate.CHANGE_STATE_LOAN_APPROVED]: {
    body: 'loans/approved_email.eta',
    subject: 'loans/loan_subject.txt',
  },
  [EmailTemplate.CHANGE_STATE_LOAN_DENIED]: {
    body: 'loans/denied_email.eta',
    subject: 'loans/loan_subject.txt',
  },
  [EmailTemplate.POWER_APPROVED]: {
    body: 'power/power_email.eta',
    subject: 'power/power_subject.txt',
  },
  [EmailTemplate.TEST]: {
    body: 'test/test_email.eta',
    subject: 'test/test_subject.txt',
  },
  [EmailTemplate.PASSWORD_RESET]: {
    body: 'registration/password_reset_email.eta',
    subject: 'registration/password_reset_subject.txt',
  },
});
