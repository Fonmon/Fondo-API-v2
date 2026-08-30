import { TEST_DATABASE_URL } from './test-database';

// Every e2e test runs against the disposable test database, never the shared dev one.
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.NODE_ENV = 'test';
process.env.ENVIRONMENT = 'test';
process.env.AWS_REGION ??= 'us-east-2';
process.env.DEFAULT_FROM_EMAIL ??= 'Fondo Montanez <no-reply@fonmon.minagle.com>';
process.env.HOST_URL_APP ??= 'http://localhost:3000';
