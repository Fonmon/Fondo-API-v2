import type { AppConfigService } from '../config/app-config.service';
import { SES_CONNECTION_TIMEOUT_MS, SES_REQUEST_TIMEOUT_MS, sesClientConfig } from './ses.client';

/** Condition **C22** / review Consider #6 — `MailService` has no retry loop of its own. */
describe('sesClientConfig', () => {
  const config = { awsRegion: 'us-east-2' } as AppConfigService;

  it('C22: does exactly one SendEmail attempt', () => {
    expect(sesClientConfig(config).maxAttempts).toBe(1);
  });

  it('C22: bounds the attempt with a connection and a socket timeout', () => {
    expect(sesClientConfig(config).requestHandler).toEqual({
      connectionTimeout: SES_CONNECTION_TIMEOUT_MS,
      requestTimeout: SES_REQUEST_TIMEOUT_MS,
    });
  });

  it('keeps the region from the validated environment', () => {
    expect(sesClientConfig(config).region).toBe('us-east-2');
  });
});
