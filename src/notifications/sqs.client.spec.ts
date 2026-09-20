import type { AppConfigService } from '../config/app-config.service';
import { SQS_CONNECTION_TIMEOUT_MS, SQS_REQUEST_TIMEOUT_MS, sqsClientConfig } from './sqs.client';

/**
 * Condition **C22** / review finding **S4** — the SQS retry budget is the publisher's, and
 * only the publisher's.
 *
 * These cells exist because the defaults they pin are *invisible*: nothing in the code said
 * "3 attempts", the SDK simply multiplied the publisher's loop by its own.
 */
describe('sqsClientConfig', () => {
  const config = { awsRegion: 'us-east-2' } as AppConfigService;

  it('C22: does exactly one SendMessage attempt, so the publisher loop is the only retry', () => {
    expect(sqsClientConfig(config).maxAttempts).toBe(1);
  });

  it('C22: bounds every attempt with a connection and a socket timeout', () => {
    expect(sqsClientConfig(config).requestHandler).toEqual({
      connectionTimeout: SQS_CONNECTION_TIMEOUT_MS,
      requestTimeout: SQS_REQUEST_TIMEOUT_MS,
    });
  });

  it('keeps the region from the validated environment', () => {
    expect(sqsClientConfig(config).region).toBe('us-east-2');
  });

  it('C22: the total publish budget stays under ten seconds', () => {
    // 3 publisher attempts x (connect + socket) + 200ms + 400ms of backoff.
    const worstCase = 3 * (SQS_CONNECTION_TIMEOUT_MS + SQS_REQUEST_TIMEOUT_MS) + 200 + 400;
    expect(worstCase).toBeLessThan(10_000);
  });
});
