import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import * as fs from 'fs';
import * as path from 'path';
import * as Handlebars from 'handlebars';
import { EmailTemplate } from '../common/enums';

const TEMPLATE_NAMES: Record<EmailTemplate, string> = {
  [EmailTemplate.USER_ACTIVATION]: 'user_activation',
  [EmailTemplate.CHANGE_STATE_LOAN_APPROVED]: 'loan_approved',
  [EmailTemplate.CHANGE_STATE_LOAN_DENIED]: 'loan_denied',
  [EmailTemplate.POWER_APPROVED]: 'power_approved',
  [EmailTemplate.TEST]: 'test',
  [EmailTemplate.PASSWORD_RESET]: 'password_reset',
};

@Injectable()
export class MailService {
  private readonly ses: SESClient;
  private readonly from: string;

  constructor(private readonly config: ConfigService) {
    this.ses = new SESClient({ region: config.get<string>('aws.region') });
    this.from = config.get<string>('aws.sesFrom') ?? '';
  }

  async sendMail(
    template: EmailTemplate,
    recipients: string[],
    params: Record<string, unknown>,
    bcc: string[] = [],
  ): Promise<boolean> {
    try {
      const html = this.renderTemplate(TEMPLATE_NAMES[template], params);
      const command = new SendEmailCommand({
        Source: this.from,
        Destination: {
          ToAddresses: recipients,
          BccAddresses: bcc,
        },
        Message: {
          Subject: { Data: this.getSubject(template) },
          Body: { Html: { Data: html } },
        },
      });
      await this.ses.send(command);
      return true;
    } catch {
      return false;
    }
  }

  private renderTemplate(
    name: string,
    params: Record<string, unknown>,
  ): string {
    const templatePath = path.join(
      __dirname,
      'templates',
      `${name}.hbs`,
    );
    const source = fs.readFileSync(templatePath, 'utf-8');
    return Handlebars.compile(source)(params);
  }

  private getSubject(template: EmailTemplate): string {
    switch (template) {
      case EmailTemplate.USER_ACTIVATION:
        return 'Activación de cuenta - Fondo Montañez';
      case EmailTemplate.CHANGE_STATE_LOAN_APPROVED:
        return 'Préstamo aprobado - Fondo Montañez';
      case EmailTemplate.CHANGE_STATE_LOAN_DENIED:
        return 'Préstamo rechazado - Fondo Montañez';
      case EmailTemplate.POWER_APPROVED:
        return 'Poder aprobado - Fondo Montañez';
      case EmailTemplate.PASSWORD_RESET:
        return 'Restablecer contraseña - Fondo Montañez';
      default:
        return 'Fondo Montañez';
    }
  }
}
