import { SQSClient } from '@aws-sdk/client-sqs';
import type { Provider } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';

/**
 * Injection token for the SQS client.
 *
 * v1 builds it at module import in `fondo_api/celery/tasks.py:9`:
 *
 * ```python
 * sqs_client = boto3.client('sqs', region_name=os.environ['AWS_REGION'])
 * ```
 *
 * A provider gives unit tests and `manual-tester` the same seam `@patch('boto3.client')`
 * gives v1's tests.
 */
export const SQS_CLIENT = Symbol('SQS_CLIENT');

export const sqsClientProvider: Provider = {
  provide: SQS_CLIENT,
  inject: [AppConfigService],
  useFactory: (config: AppConfigService): SQSClient => new SQSClient({ region: config.awsRegion }),
};
