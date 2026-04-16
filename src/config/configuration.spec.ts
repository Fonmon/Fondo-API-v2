import configuration from './configuration';

describe('configuration', () => {
  const original = { ...process.env };

  beforeEach(() => {
    process.env.PORT = '4000';
    process.env.POSTGRES_USER = 'user';
    process.env.POSTGRES_PASSWORD = 'pass';
    process.env.POSTGRES_HOST = 'db';
    process.env.POSTGRES_PORT = '5432';
    process.env.POSTGRES_DATABASE = 'mydb';
    process.env.AWS_REGION = 'us-east-1';
    process.env.DEFAULT_FROM_EMAIL = 'from@example.com';
    process.env.NOTIFICATIONS_QUEUE_URL = 'https://sqs.example.com/queue';
    process.env.HOST_URL_APP = 'https://app.example.com';
    process.env.ENVIRONMENT = 'test';
  });

  afterEach(() => {
    Object.assign(process.env, original);
  });

  it('reads port from PORT env var', () => {
    expect(configuration().port).toBe(4000);
  });

  it('defaults port to 3000 when PORT is not set', () => {
    delete process.env.PORT;
    expect(configuration().port).toBe(3000);
  });

  it('builds database URL from individual POSTGRES_* vars', () => {
    expect(configuration().database.url).toBe(
      'postgresql://user:pass@db:5432/mydb',
    );
  });

  it('reads AWS config', () => {
    const { aws } = configuration();
    expect(aws.region).toBe('us-east-1');
    expect(aws.sesFrom).toBe('from@example.com');
    expect(aws.notificationsQueueUrl).toBe('https://sqs.example.com/queue');
  });

  it('reads app config', () => {
    const { app } = configuration();
    expect(app.hostUrlApp).toBe('https://app.example.com');
    expect(app.environment).toBe('test');
  });

  it('defaults environment to production when not set', () => {
    delete process.env.ENVIRONMENT;
    expect(configuration().app.environment).toBe('production');
  });
});
