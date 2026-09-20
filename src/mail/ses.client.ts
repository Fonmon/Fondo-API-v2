import { SESClient, type SESClientConfig } from '@aws-sdk/client-ses';
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

export const SES_CONNECTION_TIMEOUT_MS = 1_000;

/**
 * Per-attempt socket budget. Larger than SQS's because a `SendEmail` carries the whole
 * rendered HTML body (the loan-approval mail is a full amortization table).
 */
export const SES_REQUEST_TIMEOUT_MS = 5_000;

/**
 * The client configuration, exported so it can be asserted without constructing a client.
 *
 * ## Why one attempt and an explicit timeout — condition **C22** (finding **S4**, Consider #6)
 *
 * `MailService.sendMail` has **no** retry loop of its own: it returns `false` on the first
 * failure and `create_user` rolls its four rows back (`services/user.py:53`). So every retry
 * here is invisible to the caller and is pure added latency on the HTTP request thread —
 * Phase 3's `POST /api/user` waits for it inside a database transaction.
 *
 * The SDK's default is `maxAttempts: 3` with no request timeout; boto3's legacy default (what
 * v1 actually runs) is **5** attempts. Neither is a decision anyone made. One attempt with a
 * 5 s socket budget bounds the mail leg of `create_user` at ~6 s, and an SES outage rolls the
 * transaction back promptly instead of holding a connection open indefinitely.
 */
export function sesClientConfig(config: AppConfigService): SESClientConfig {
  return {
    region: config.awsRegion,
    maxAttempts: 1,
    requestHandler: {
      connectionTimeout: SES_CONNECTION_TIMEOUT_MS,
      requestTimeout: SES_REQUEST_TIMEOUT_MS,
    },
  };
}

export const sesClientProvider: Provider = {
  provide: SES_CLIENT,
  inject: [AppConfigService],
  useFactory: (config: AppConfigService): SESClient => new SESClient(sesClientConfig(config)),
};
