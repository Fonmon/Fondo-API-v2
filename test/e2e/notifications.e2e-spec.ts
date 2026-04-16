import * as request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { acquireApp, releaseApp, adminAuth } from './helpers/setup';

const testSubscription = {
  endpoint: `https://fcm.googleapis.com/fcm/send/test-e2e-${Date.now()}`,
  expirationTime: null,
  keys: {
    p256dh: 'BLc4xRzKlKORKWlbdgFaBrrPK3ydWAHo2JCZLf4BNJhcwi_W6aaRAoRIqXf3RIhqnXbqJ-v4l1u2lHQ=',
    auth: 'Jf3FoMiuTFGBFEsv',
  },
};

describe('Notifications (e2e)', () => {
  let app: INestApplication;
  let server: any;

  beforeAll(async () => {
    app = await acquireApp();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await releaseApp();
  });

  describe('POST /api/notification/subscribe', () => {
    it('returns 200 on subscribe', async () => {
      const res = await request(server)
        .post('/api/notification/subscribe')
        .set(adminAuth())
        .send(testSubscription);
      expect(res.status).toBe(200);
    });

    it('returns 200 on duplicate subscribe (idempotent)', async () => {
      // Subscribe again with same endpoint — should not fail
      const res = await request(server)
        .post('/api/notification/subscribe')
        .set(adminAuth())
        .send(testSubscription);
      expect(res.status).toBe(200);
    });
  });

  describe('POST /api/notification/unsubscribe', () => {
    it('returns 200 on unsubscribe', async () => {
      const res = await request(server)
        .post('/api/notification/unsubscribe')
        .set(adminAuth())
        .send(testSubscription);
      expect(res.status).toBe(200);
    });
  });

  describe('POST /api/notification/:operation — invalid operation', () => {
    it('returns 405 for unknown operation', async () => {
      const res = await request(server)
        .post('/api/notification/invalidop')
        .set(adminAuth())
        .send(testSubscription);
      expect(res.status).toBe(405);
    });
  });

  describe('Role enforcement', () => {
    it('returns 401 without auth', async () => {
      const res = await request(server)
        .post('/api/notification/subscribe')
        .send(testSubscription);
      expect(res.status).toBe(401);
    });
  });
});
