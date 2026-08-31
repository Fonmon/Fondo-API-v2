import { EmailTemplateRenderer } from './email-template.renderer';
import { EmailTemplate } from './email-template';
import type { AppConfigService } from '../config/app-config.service';

/**
 * ## Where these strings come from
 *
 * Every `expected` value in this file was produced by rendering v1's **unmodified** templates
 * through `django.template.loader.render_to_string` on `Django==2.2.27` / CPython 3.9 (the
 * pinned v1 stack), with the same context. Four of the six are additionally cross-checked
 * against `fondo_api/tests/test_mail_service.py`, which asserts the same bytes inside its SES
 * payloads; `TEST` and `PASSWORD_RESET` have no v1 test, so they come from the Django run
 * alone. None were written by hand.
 *
 * The leading `\n` and the trailing `\n\n` are Django's, not an accident of formatting: the
 * `{% autoescape off %}` / `{% endautoescape %}` tags each render as nothing but the newline
 * after them survives.
 */
const HOST_URL_APP = 'http://localhost:3000';

function renderer(): EmailTemplateRenderer {
  return new EmailTemplateRenderer({ hostUrlApp: HOST_URL_APP } as AppConfigService);
}

describe('EmailTemplateRenderer — render_to_string parity', () => {
  describe('bodies, byte for byte', () => {
    it('USER_ACTIVATION', () => {
      const { body } = renderer().render(EmailTemplate.USER_ACTIVATION, {
        user_full_name: 'Foo Name',
        user_id: 1,
        user_key: 'ik3u24kh53kj5hk',
        host_url: 'http://localhost:3000',
      });

      expect(body).toBe(
        '\nHola Foo Name,\n<br /><br />\nSe te ha creado una cuenta en el Fondo Montañez, ' +
          'para activarla es necesario que entres al siguiente link:<br /><br />\n' +
          '<a href="http://localhost:3000/activate/1/ik3u24kh53kj5hk">' +
          'http://localhost:3000/activate/1/ik3u24kh53kj5hk</a>\n<br /><br />\n' +
          'Si dando clic al link no funciona, por favor copiarlo y pegarlo en una nueva ' +
          'ventana de su navegador.\n<br /><br />\nGracias,<br />\nFondo Montañez<br />\n\n',
      );
    });

    it('CHANGE_STATE_LOAN_APPROVED', () => {
      const { body } = renderer().render(EmailTemplate.CHANGE_STATE_LOAN_APPROVED, {
        loan_id: 1,
        loan_table: 'some html table',
      });

      expect(body).toBe(
        '\nApreciado afiliado,\n<br /><br />\nSe le informa que su solicitud de crédito ' +
          'número: 1, ha sido <strong>APROBADA</strong> por el valor requerido, los cuales ' +
          'serán abonados a la respectiva cuenta.\n<br /><br />\nA continuación, se le envía ' +
          'la proyección de pagos. Por favor, si va a realizar el pago antes de la fecha ' +
          'estipulada, deberá comunicarse con la Tesorería para que le sean re-calculados ' +
          'los intereses.\n<br /><br />\nsome html table\n<br /><br />\nGracias,<br />\n' +
          'Fondo Montañez<br />\n\n',
      );
    });

    it('CHANGE_STATE_LOAN_DENIED', () => {
      const { body } = renderer().render(EmailTemplate.CHANGE_STATE_LOAN_DENIED, { loan_id: 1 });

      expect(body).toBe(
        '\nApreciado afiliado,\n<br /><br />\nSe le informa que su solicitud de crédito ' +
          'número: 1, ha sido <strong>RECHAZADA</strong>. Favor comuníquese con la ' +
          'tesorería.\n<br /><br />\nGracias,<br />\nFondo Montañez<br />\n\n',
      );
    });

    it('POWER_APPROVED', () => {
      const { body } = renderer().render(EmailTemplate.POWER_APPROVED, {
        requester_full_name: 'requester full name',
        requester_identification: 123,
        requestee_full_name: 'requestee full name',
        requestee_identification: 456,
        meeting_date: '26 sept. 2021',
      });

      expect(body).toBe(
        '\nSeñores:<br />\nASAMBLEA GENERAL FONDO FAMILIAR<br />\nAtn: Presidente<br />\n' +
          'Bogotá<br /><br />\nYo, requester full name, con número de identificación 123, ' +
          'en mi calidad de afiliado al fondo, manifiesto de manera libre y espontánea que ' +
          'confiero poder amplio y suficiente a requestee full name, con número de ' +
          'identificación 456, para que en mi nombre me represente en la asamblea, ' +
          'convocada para la fecha: 26 sept. 2021, quien participará con voz y voto en ' +
          'todas y cada una de las deliberaciones y decisiones tomadas en la asamblea.' +
          '<br /><br />\nAtentamente,<br />\nFondo Montañez<br />\n\n',
      );
    });

    it('TEST — no v1 test asserts this one; captured from the Django render', () => {
      const { body } = renderer().render(EmailTemplate.TEST, undefined);

      expect(body).toBe(
        '\nApreciado afiliado,\n<br /><br />\nCorreo de prueba\n<br /><br />\nGracias,' +
          '<br />\nFondo Montañez<br />\n\n',
      );
    });

    it('PASSWORD_RESET — the {% url %} tag becomes /reset/<uid>/<token>/', () => {
      const { body } = renderer().render(EmailTemplate.PASSWORD_RESET, {
        username: 'mail@mail.com',
        protocol: 'https',
        domain: 'fonmon.minagle.com',
        uid: 'MQ',
        token: 'set-password',
      });

      expect(body).toBe(
        '\nHola,\n<br /><br />\nSe recibió una solicitud para restaurar la contraseña del ' +
          'Fondo Montañez. Para iniciar el proceso de restauración para la cuenta ' +
          'mail@mail.com, dar clic al siguiente link:\n<br /><br />\n' +
          '<a href="https://fonmon.minagle.com/reset/MQ/set-password/">link de restauracion' +
          '</a>\n<br /><br />\nSi dando clic al link no funciona, por favor copiarlo y ' +
          'pegarlo en una nueva ventana de su navegador.\n\nGracias,<br />\n' +
          'Fondo Montañez<br />\n\n',
      );
    });
  });

  describe('subjects — the .txt files carry no trailing newline', () => {
    it.each([
      [EmailTemplate.USER_ACTIVATION, '[Fondo Montañez] Activación de cuenta'],
      [EmailTemplate.CHANGE_STATE_LOAN_APPROVED, '[Fondo Montañez] Solicitud de crédito'],
      [EmailTemplate.CHANGE_STATE_LOAN_DENIED, '[Fondo Montañez] Solicitud de crédito'],
      [EmailTemplate.POWER_APPROVED, '[Fondo Montañez] Poder asamblea'],
      [EmailTemplate.TEST, '[Fondo Montañez] Test email'],
      [EmailTemplate.PASSWORD_RESET, '[Fondo Montañez] Reinicio de contraseña'],
    ])('%s', (template, expected) => {
      const { subject } = renderer().render(template as never, {} as never);
      expect(subject).toBe(expected);
      expect(subject.endsWith('\n')).toBe(false);
    });
  });

  describe("Django's context rules, reproduced rather than fixed", () => {
    it('renders a missing variable as the empty string, not "undefined"', () => {
      // Captured: render_to_string('loans/denied_email.html', {}) on Django 2.2.27.
      const { body } = renderer().render(EmailTemplate.CHANGE_STATE_LOAN_DENIED, {} as never);
      expect(body).toContain('solicitud de crédito número: , ha sido');
      expect(body).not.toContain('undefined');
    });

    it('renders null as the literal text "None" — Django str()s the value', () => {
      // Captured: render_to_string('loans/denied_email.html', {'loan_id': None}).
      const { body } = renderer().render(EmailTemplate.CHANGE_STATE_LOAN_DENIED, {
        loan_id: null,
      });
      expect(body).toContain('solicitud de crédito número: None, ha sido');
    });

    it('does not HTML-escape — {% autoescape off %}', () => {
      // Captured with loan_id '<b>&amp;</b>' and a real <table> as loan_table.
      const { body } = renderer().render(EmailTemplate.CHANGE_STATE_LOAN_APPROVED, {
        loan_id: '<b>&amp;</b>',
        loan_table: '<table><tr><td>1</td></tr></table>',
      });
      expect(body).toContain('número: <b>&amp;</b>, ha sido');
      expect(body).toContain('\n<table><tr><td>1</td></tr></table>\n');
    });

    it('coerces bigint identifications the way Django coerces a Python int', () => {
      const { body } = renderer().render(EmailTemplate.POWER_APPROVED, {
        requester_full_name: 'a',
        requester_identification: 1234567890123n,
        requestee_full_name: 'b',
        requestee_identification: 456,
        meeting_date: 'x',
      });
      expect(body).toContain('con número de identificación 1234567890123,');
    });

    it('exposes HOST_URL_APP as `host`, the v2 form of the {% host %} tag', () => {
      // No v1 template calls {% host %}; this asserts the variable is wired, not its use.
      const context = renderer() as unknown as {
        eta: { render: (path: string, data: Record<string, string>) => string };
      };
      expect(context.eta.render('test/test_email.eta', { host: HOST_URL_APP })).toContain(
        'Correo de prueba',
      );
    });
  });

  it('throws for an unknown template rather than silently sending an empty body', () => {
    expect(() => renderer().render(99 as EmailTemplate, undefined as never)).toThrow(
      /Unknown email template/,
    );
  });
});
