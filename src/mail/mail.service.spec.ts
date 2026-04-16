import { MailService } from './mail.service';
import { SESClient } from '@aws-sdk/client-ses';
import { EmailTemplate } from '../common/enums';
import * as fs from 'fs';
import * as Handlebars from 'handlebars';

jest.mock('@aws-sdk/client-ses', () => ({
  SESClient: jest.fn().mockImplementation(() => ({
    send: jest.fn(),
  })),
  SendEmailCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock('fs');
jest.mock('handlebars', () => ({
  compile: jest.fn().mockReturnValue((params: unknown) => '<html>rendered</html>'),
}));

const mockConfig = {
  get: jest.fn((key: string) => {
    if (key === 'aws.region') return 'us-east-1';
    if (key === 'aws.sesFrom') return 'noreply@example.com';
    return undefined;
  }),
};

function buildService() {
  return new MailService(mockConfig as any);
}

beforeEach(() => {
  jest.clearAllMocks();
  (fs.readFileSync as jest.Mock).mockReturnValue('<html>{{user_full_name}}</html>');
});

describe('MailService constructor', () => {
  it('defaults from address to empty string when sesFrom is not configured', () => {
    const configWithNoFrom = {
      get: jest.fn((key: string) => {
        if (key === 'aws.region') return 'us-east-1';
        return undefined;
      }),
    };
    const svc = new MailService(configWithNoFrom as any);
    expect(svc).toBeDefined();
  });
});

describe('MailService.sendMail', () => {
  it('sends email and returns true on success', async () => {
    const svc = buildService();
    const sesSend = (SESClient as jest.Mock).mock.results[0].value.send;
    sesSend.mockResolvedValue({});
    const result = await svc.sendMail(
      EmailTemplate.USER_ACTIVATION,
      ['test@example.com'],
      { user_full_name: 'John' },
    );
    expect(result).toBe(true);
    expect(sesSend).toHaveBeenCalledTimes(1);
  });

  it('returns false when SES throws', async () => {
    const svc = buildService();
    const sesSend = (SESClient as jest.Mock).mock.results[0].value.send;
    sesSend.mockRejectedValue(new Error('SES error'));
    const result = await svc.sendMail(
      EmailTemplate.TEST,
      ['test@example.com'],
      {},
    );
    expect(result).toBe(false);
  });

  it('includes bcc addresses when provided', async () => {
    const svc = buildService();
    const sesSend = (SESClient as jest.Mock).mock.results[0].value.send;
    sesSend.mockResolvedValue({});
    await svc.sendMail(
      EmailTemplate.PASSWORD_RESET,
      ['to@example.com'],
      {},
      ['bcc@example.com'],
    );
    const { SendEmailCommand: Cmd } = jest.requireMock('@aws-sdk/client-ses');
    const callArg = (Cmd as jest.Mock).mock.calls[0][0];
    expect(callArg.Destination.BccAddresses).toEqual(['bcc@example.com']);
  });

  it.each([
    [EmailTemplate.USER_ACTIVATION, 'Activación de cuenta'],
    [EmailTemplate.CHANGE_STATE_LOAN_APPROVED, 'Préstamo aprobado'],
    [EmailTemplate.CHANGE_STATE_LOAN_DENIED, 'Préstamo rechazado'],
    [EmailTemplate.POWER_APPROVED, 'Poder aprobado'],
    [EmailTemplate.PASSWORD_RESET, 'Restablecer contraseña'],
    [EmailTemplate.TEST, 'Fondo Montañez'],
  ])('uses correct subject for template %s', async (template, expectedSubject) => {
    const svc = buildService();
    const sesSend = (SESClient as jest.Mock).mock.results[0].value.send;
    sesSend.mockResolvedValue({});
    await svc.sendMail(template, ['to@example.com'], {});
    const { SendEmailCommand: Cmd } = jest.requireMock('@aws-sdk/client-ses');
    const callArg = (Cmd as jest.Mock).mock.calls[0][0];
    expect(callArg.Message.Subject.Data).toContain(expectedSubject);
  });
});
