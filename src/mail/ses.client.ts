import { SESClient } from '@aws-sdk/client-ses';
import type { Provider } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';

/**
 * Injection token for the SES client.
 *
 * v1 constructs it in `MailService.__init__`:
 *
 * ```python
 * self.__ses_client = boto3.client('ses', region_name=os.environ['AWS_REGION'])
 * ```
 *
 * and its tests replace it with `@patch('boto3.client')`. Making the client a provider is
 * the v2 equivalent of that seam: unit tests inject a fake, and `manual-tester` can point a
 * whole app at a local SES stub without touching `MailService`.
 *
 * Credentials come from the default AWS provider chain, exactly as boto3's do — v1 sets no
 * explicit credentials either (the EC2 instance role supplies them).
 */
export const SES_CLIENT = Symbol('SES_CLIENT');

export const sesClientProvider: Provider = {
  provide: SES_CLIENT,
  inject: [AppConfigService],
  useFactory: (config: AppConfigService): SESClient => new SESClient({ region: config.awsRegion }),
};
