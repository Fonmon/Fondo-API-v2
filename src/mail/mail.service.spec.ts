import { SendEmailCommand, type SESClient } from '@aws-sdk/client-ses';
import type { AppConfigService } from '../config/app-config.service';
import { EmailTemplate } from './email-template';
import { EmailTemplateRenderer } from './email-template.renderer';
import { MailService } from './mail.service';

/**
 * Port of `fondo_api/tests/test_mail_service.py` — all six methods, same names, same
 * assertions.
 *
 * v1 patches `boto3.client` and asserts the **entire** `send_email(**kwargs)` call. The v2
 * equivalent asserts the entire `SendEmailCommandInput`, so a stray field or a lost
 * `BccAddresses` fails the same way. The HTML strings are the ones v1's tests assert
 * verbatim; `email-template.renderer.spec.ts` re-derives them from a real Django render.
 *
 * | v1 test | here |
 * |---|---|
 * | `test_send_mail_exception` | *returns false when SES raises* |
 * | `test_send_mail_user_activation` | *USER_ACTIVATION* |
 * | `test_send_mail_change_state_loan_approved` | *CHANGE_STATE_LOAN_APPROVED* |
 * | `test_send_mail_change_state_loan_denied` | *CHANGE_STATE_LOAN_DENIED* |
 * | `test_send_mail_power_approved` | *POWER_APPROVED* |
 * | `test_send_mail_repeated_emails` | *drops a bcc address that is also a recipient* |
 */
const SOURCE = 'Fondo Montanez <no-reply@fonmon.minagle.com>';

const ACTIVATION_HTML =
  '\nHola Foo Name,\n<br /><br />\nSe te ha creado una cuenta en el Fondo Montañez, ' +
  'para activarla es necesario que entres al siguiente link:<br /><br />\n' +
  '<a href="http://localhost:3000/activate/1/ik3u24kh53kj5hk">' +
  'http://localhost:3000/activate/1/ik3u24kh53kj5hk</a>\n<br /><br />\n' +
  'Si dando clic al link no funciona, por favor copiarlo y pegarlo en una nueva ventana ' +
  'de su navegador.\n<br /><br />\nGracias,<br />\nFondo Montañez<br />\n\n';

const APPROVED_HTML =
  '\nApreciado afiliado,\n<br /><br />\nSe le informa que su solicitud de crédito número: ' +
  '1, ha sido <strong>APROBADA</strong> por el valor requerido, los cuales serán abonados ' +
  'a la respectiva cuenta.\n<br /><br />\nA continuación, se le envía la proyección de ' +
  'pagos. Por favor, si va a realizar el pago antes de la fecha estipulada, deberá ' +
  'comunicarse con la Tesorería para que le sean re-calculados los intereses.\n<br /><br />' +
  '\nsome html table\n<br /><br />\nGracias,<br />\nFondo Montañez<br />\n\n';

const DENIED_HTML =
  '\nApreciado afiliado,\n<br /><br />\nSe le informa que su solicitud de crédito número: ' +
  '1, ha sido <strong>RECHAZADA</strong>. Favor comuníquese con la tesorería.\n<br /><br />' +
  '\nGracias,<br />\nFondo Montañez<br />\n\n';

const POWER_HTML =
  '\nSeñores:<br />\nASAMBLEA GENERAL FONDO FAMILIAR<br />\nAtn: Presidente<br />\n' +
  'Bogotá<br /><br />\nYo, requester full name, con número de identificación 123, en mi ' +
  'calidad de afiliado al fondo, manifiesto de manera libre y espontánea que confiero ' +
  'poder amplio y suficiente a requestee full name, con número de identificación 456, ' +
  'para que en mi nombre me represente en la asamblea, convocada para la fecha: ' +
  '26 sept. 2021, quien participará con voz y voto en todas y cada una de las ' +
  'deliberaciones y decisiones tomadas en la asamblea.<br /><br />\nAtentamente,<br />\n' +
  'Fondo Montañez<br />\n\n';

describe('MailService — fondo_api/services/mail.py', () => {
  let ses: { send: jest.Mock };
  let service: MailService;

  /** The single argument v1's `SES.send_email.assert_called_once_with(...)` checks. */
  function sentInput(): Record<string, unknown> {
    expect(ses.send).toHaveBeenCalledTimes(1);
    const calls = ses.send.mock.calls as unknown as [SendEmailCommand][];
    const command = calls[0][0];
    expect(command).toBeInstanceOf(SendEmailCommand);
    return command.input as unknown as Record<string, unknown>;
  }

  function expectPayload(html: string, subject: string, to: string[], bcc: string[]): void {
    expect(sentInput()).toEqual({
      Destination: { ToAddresses: to, BccAddresses: bcc },
      Message: {
        Body: { Html: { Charset: 'UTF-8', Data: html } },
        Subject: { Charset: 'UTF-8', Data: subject },
      },
      Source: SOURCE,
    });
  }

  beforeEach(() => {
    ses = { send: jest.fn().mockResolvedValue(undefined) };
    const config = {
      defaultFromEmail: SOURCE,
      hostUrlApp: 'http://localhost:3000',
    } as AppConfigService;
    service = new MailService(
      ses as unknown as SESClient,
      config,
      new EmailTemplateRenderer(config),
    );
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
  });

  it('returns false when SES raises — create_user depends on this to roll back', async () => {
    ses.send.mockRejectedValue(new Error('there was an error'));

    const result = await service.sendMail(EmailTemplate.USER_ACTIVATION, ['mail@mail.com'], {
      user_full_name: 'Foo Name',
      user_id: 1,
      user_key: 'ik3u24kh53kj5hk',
      host_url: 'http://localhost:3000',
    });

    expect(result).toBe(false);
  });

  it('returns false when the SES client throws synchronously', async () => {
    ses.send.mockImplementation(() => {
      throw new Error('credentials missing');
    });

    await expect(
      service.sendMail(EmailTemplate.CHANGE_STATE_LOAN_DENIED, ['mail@mail.com'], { loan_id: 1 }),
    ).resolves.toBe(false);
  });

  it('returns false when the template cannot be rendered, and does not call SES', async () => {
    const result = await service.sendMail(99 as EmailTemplate, ['mail@mail.com'], undefined);

    expect(result).toBe(false);
    expect(ses.send).not.toHaveBeenCalled();
  });

  it('USER_ACTIVATION', async () => {
    const result = await service.sendMail(EmailTemplate.USER_ACTIVATION, ['mail@mail.com'], {
      user_full_name: 'Foo Name',
      user_id: 1,
      user_key: 'ik3u24kh53kj5hk',
      host_url: 'http://localhost:3000',
    });

    expect(result).toBe(true);
    expectPayload(ACTIVATION_HTML, '[Fondo Montañez] Activación de cuenta', ['mail@mail.com'], []);
  });

  it('CHANGE_STATE_LOAN_APPROVED', async () => {
    const result = await service.sendMail(
      EmailTemplate.CHANGE_STATE_LOAN_APPROVED,
      ['mail@mail.com'],
      { loan_table: 'some html table', loan_id: 1 },
    );

    expect(result).toBe(true);
    expectPayload(APPROVED_HTML, '[Fondo Montañez] Solicitud de crédito', ['mail@mail.com'], []);
  });

  it('CHANGE_STATE_LOAN_DENIED', async () => {
    const result = await service.sendMail(
      EmailTemplate.CHANGE_STATE_LOAN_DENIED,
      ['mail@mail.com'],
      { loan_id: 1 },
    );

    expect(result).toBe(true);
    expectPayload(DENIED_HTML, '[Fondo Montañez] Solicitud de crédito', ['mail@mail.com'], []);
  });

  it('POWER_APPROVED', async () => {
    const result = await service.sendMail(EmailTemplate.POWER_APPROVED, ['mail@mail.com'], {
      requester_full_name: 'requester full name',
      requester_identification: 123,
      requestee_full_name: 'requestee full name',
      requestee_identification: 456,
      meeting_date: '26 sept. 2021',
    });

    expect(result).toBe(true);
    expectPayload(POWER_HTML, '[Fondo Montañez] Poder asamblea', ['mail@mail.com'], []);
  });

  it('drops a bcc address that is also a recipient', async () => {
    const result = await service.sendMail(
      EmailTemplate.CHANGE_STATE_LOAN_APPROVED,
      ['mail@mail.com'],
      { loan_table: 'some html table', loan_id: 1 },
      ['mail@mail.com', 'mail2@mail.com'],
    );

    expect(result).toBe(true);
    expectPayload(
      APPROVED_HTML,
      '[Fondo Montañez] Solicitud de crédito',
      ['mail@mail.com'],
      ['mail2@mail.com'],
    );
  });

  describe('bcc deduplication follows list.remove semantics', () => {
    it('removes only one occurrence per recipient, as Python does', async () => {
      // `fondodev` has two pairs of members sharing an email address, so
      // get_users_attr('email', [0, 2]) really can return a duplicate.
      await service.sendMail(
        EmailTemplate.CHANGE_STATE_LOAN_DENIED,
        ['dup@mail.com'],
        { loan_id: 1 },
        ['dup@mail.com', 'other@mail.com', 'dup@mail.com'],
      );

      expect(sentInput().Destination).toEqual({
        ToAddresses: ['dup@mail.com'],
        BccAddresses: ['other@mail.com', 'dup@mail.com'],
      });
    });

    it('removes one occurrence per repeated recipient', async () => {
      await service.sendMail(
        EmailTemplate.CHANGE_STATE_LOAN_DENIED,
        ['dup@mail.com', 'dup@mail.com'],
        { loan_id: 1 },
        ['dup@mail.com', 'dup@mail.com', 'keep@mail.com'],
      );

      expect(sentInput().Destination).toEqual({
        ToAddresses: ['dup@mail.com', 'dup@mail.com'],
        BccAddresses: ['keep@mail.com'],
      });
    });

    it('does not mutate the caller-supplied bcc array', async () => {
      // v1 does mutate it (`bcc.remove(...)`); no call site can observe the difference.
      const bcc = ['mail@mail.com', 'mail2@mail.com'];
      await service.sendMail(
        EmailTemplate.CHANGE_STATE_LOAN_DENIED,
        ['mail@mail.com'],
        { loan_id: 1 },
        bcc,
      );

      expect(bcc).toEqual(['mail@mail.com', 'mail2@mail.com']);
    });

    it('defaults bcc to empty and never shares that default between calls', async () => {
      await service.sendMail(EmailTemplate.CHANGE_STATE_LOAN_DENIED, ['a@mail.com'], {
        loan_id: 1,
      });
      expect((sentInput().Destination as { BccAddresses: string[] }).BccAddresses).toEqual([]);
    });
  });
});
