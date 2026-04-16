import * as request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { acquireApp, releaseApp, adminAuth, presidentAuth } from './helpers/setup';

describe('Saving Accounts (e2e)', () => {
  let app: INestApplication;
  let server: any;

  beforeAll(async () => {
    app = await acquireApp();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await releaseApp();
  });

  describe('GET /api/saving-account', () => {
    it('returns paginated saving account list', async () => {
      const res = await request(server)
        .get('/api/saving-account?page=1')
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('list');
      expect(Array.isArray(res.body.list)).toBe(true);
      expect(res.body).toHaveProperty('num_pages');
      expect(res.body).toHaveProperty('count');
    });

    it('returns unpaginated when paginate=false', async () => {
      const res = await request(server)
        .get('/api/saving-account?paginate=false')
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('list');
      expect(res.body).not.toHaveProperty('num_pages');
    });

    it('returns 401 without auth', async () => {
      const res = await request(server).get('/api/saving-account');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/saving-account (create)', () => {
    it('returns 200 with account id on creation', async () => {
      const futureDate = new Date();
      futureDate.setFullYear(futureDate.getFullYear() + 1);
      const endDate = futureDate.toISOString().split('T')[0];

      const res = await request(server)
        .post('/api/saving-account')
        .set(adminAuth())
        .send({ end_date: endDate, value: 500 });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('id');
    });

    it('president can also create saving accounts', async () => {
      const futureDate = new Date();
      futureDate.setFullYear(futureDate.getFullYear() + 1);
      const endDate = futureDate.toISOString().split('T')[0];

      const res = await request(server)
        .post('/api/saving-account')
        .set(presidentAuth())
        .send({ end_date: endDate, value: 100 });
      expect(res.status).toBe(200);
    });
  });

  describe('PUT /api/saving-account (update)', () => {
    it('returns 403 for president (only admin/treasurer can update)', async () => {
      const res = await request(server)
        .put('/api/saving-account')
        .set(presidentAuth())
        .send({ id: 1, state: 1, value: 0 });
      expect(res.status).toBe(403);
    });

    it('returns 404 for non-existent account', async () => {
      const res = await request(server)
        .put('/api/saving-account')
        .set(adminAuth())
        .send({ id: 999999, state: 1, value: 0 });
      expect(res.status).toBe(404);
    });
  });

  describe('Account field format', () => {
    it('saving accounts have Spanish date format for created_at and end_date', async () => {
      // Create an account first
      const futureDate = new Date();
      futureDate.setFullYear(futureDate.getFullYear() + 1);
      const endDate = futureDate.toISOString().split('T')[0];

      const createRes = await request(server)
        .post('/api/saving-account')
        .set(adminAuth())
        .send({ end_date: endDate, value: 100 });
      expect(createRes.status).toBe(200);

      // Fetch and check date format
      const listRes = await request(server)
        .get('/api/saving-account?paginate=false')
        .set(adminAuth());
      expect(listRes.status).toBe(200);
      if (listRes.body.list.length > 0) {
        const account = listRes.body.list[0];
        expect(account).toHaveProperty('created_at');
        expect(account).toHaveProperty('end_date');
        // Should be Spanish locale format e.g. "9 ene. 2025"
        expect(typeof account.created_at).toBe('string');
        expect(account.created_at).toMatch(/\d+ \w+\.? \d{4}/);
      }
    });
  });
});
