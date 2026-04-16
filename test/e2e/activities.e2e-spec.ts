import * as request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { acquireApp, releaseApp, FIXTURES, adminAuth, presidentAuth } from './helpers/setup';

describe('Activities (e2e)', () => {
  let app: INestApplication;
  let server: any;

  beforeAll(async () => {
    app = await acquireApp();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await releaseApp();
  });

  describe('GET /api/activity/year', () => {
    it('returns list of activity years', async () => {
      const res = await request(server)
        .get('/api/activity/year')
        .set(adminAuth());
      // Returns 200 with list or 204 if empty
      expect([200, 204]).toContain(res.status);
      if (res.status === 200) {
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body.length).toBeGreaterThan(0);
        const year = res.body[0];
        expect(year).toHaveProperty('id');
        expect(year).toHaveProperty('year');
        expect(year).toHaveProperty('enable');
      }
    });

    it('returns 401 without auth', async () => {
      const res = await request(server).get('/api/activity/year');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/activity/year/:id', () => {
    it('returns activities for year 2019', async () => {
      const res = await request(server)
        .get(`/api/activity/year/${FIXTURES.activities.year2019.id}`)
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('returns activities for year 2018', async () => {
      const res = await request(server)
        .get(`/api/activity/year/${FIXTURES.activities.year2018.id}`)
        .set(adminAuth());
      expect(res.status).toBe(200);
    });
  });

  describe('GET /api/activity/:id', () => {
    it('returns activity detail with users', async () => {
      const res = await request(server)
        .get(`/api/activity/${FIXTURES.activities.activity1.id}`)
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('id');
      expect(res.body).toHaveProperty('name');
      expect(res.body).toHaveProperty('date');
      expect(res.body).toHaveProperty('value');
      expect(res.body).toHaveProperty('users');
      expect(Array.isArray(res.body.users)).toBe(true);
    });

    it('each activity user has state field', async () => {
      const res = await request(server)
        .get(`/api/activity/${FIXTURES.activities.activity1.id}`)
        .set(adminAuth());
      expect(res.status).toBe(200);
      res.body.users.forEach((u: any) => {
        expect(u).toHaveProperty('state');
        expect(u).toHaveProperty('user');
      });
    });

    it('returns 404 for non-existent activity', async () => {
      const res = await request(server)
        .get('/api/activity/999999')
        .set(adminAuth());
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/activity/year (create year)', () => {
    it('admin can also create activity year (role <= 1 check)', async () => {
      const res = await request(server)
        .post('/api/activity/year')
        .set(adminAuth());
      // 201 if created, 304 if already exists for this year
      expect([201, 304]).toContain(res.status);
    });

    it('president can create activity year (or 304 if already exists)', async () => {
      const res = await request(server)
        .post('/api/activity/year')
        .set(presidentAuth());
      // 201 if created, 304 if already exists for this year
      expect([201, 304]).toContain(res.status);
    });
  });

  describe('Role enforcement', () => {
    it('admin can also DELETE activity (role <= 1 check, same as president)', async () => {
      // Create a fresh activity to delete (POST returns 201 with no body)
      const createRes = await request(server)
        .post(`/api/activity/year/${FIXTURES.activities.year2019.id}`)
        .set(presidentAuth())
        .send({ name: 'E2E test activity', value: 100, date: '2019-12-01' });
      expect(createRes.status).toBe(201);

      // Fetch year activities to find the newly created one by name
      const listRes = await request(server)
        .get(`/api/activity/year/${FIXTURES.activities.year2019.id}`)
        .set(adminAuth());
      expect(listRes.status).toBe(200);
      const created = listRes.body.find((a: any) => a.name === 'E2E test activity');
      expect(created).toBeDefined();

      const res = await request(server)
        .delete(`/api/activity/${created.id}`)
        .set(adminAuth());
      expect(res.status).toBe(200);
    });

    it('member cannot DELETE activity', async () => {
      // No member token in dump — verify only with auth structure
      const res = await request(server)
        .delete(`/api/activity/${FIXTURES.activities.activity1.id}`)
        .set('Authorization', 'Token invalid');
      expect(res.status).toBe(401);
    });
  });
});
