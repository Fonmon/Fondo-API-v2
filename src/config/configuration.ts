export default () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  database: {
    url: `postgresql://${process.env.POSTGRES_USER}:${process.env.POSTGRES_PASSWORD}@${process.env.POSTGRES_HOST}:${process.env.POSTGRES_PORT}/${process.env.POSTGRES_DATABASE}`,
  },
  aws: {
    region: process.env.AWS_REGION,
    sesFrom: process.env.DEFAULT_FROM_EMAIL,
    notificationsQueueUrl: process.env.NOTIFICATIONS_QUEUE_URL,
  },
  app: {
    hostUrlApp: process.env.HOST_URL_APP,
    environment: process.env.ENVIRONMENT ?? 'production',
  },
});
