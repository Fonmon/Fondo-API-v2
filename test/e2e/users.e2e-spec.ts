import * as request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { acquireApp, releaseApp, FIXTURES, adminAuth, presidentAuth } from './helpers/setup';

describe('Users (e2e)', () => {
  let app: INestApplication;
  let server: any;

  beforeAll(async () => {
    app = await acquireApp();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await releaseApp();
  });

  describe('GET /api/user', () => {
    it('returns paginated user list for admin', async () => {
      const res = await request(server)
        .get('/api/user?page=1')
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('list');
      expect(Array.isArray(res.body.list)).toBe(true);
      expect(res.body).toHaveProperty('num_pages');
      expect(res.body).toHaveProperty('count');
    });

    it('each user has expected fields', async () => {
      const res = await request(server)
        .get('/api/user?page=1')
        .set(adminAuth());
      expect(res.status).toBe(200);
      const user = res.body.list[0];
      expect(user).toHaveProperty('id');
      expect(user).toHaveProperty('identification');
      expect(user).toHaveProperty('full_name');
      expect(user).toHaveProperty('email');
      expect(user).toHaveProperty('role');
    });

    it('returns 401 without auth', async () => {
      const res = await request(server).get('/api/user?page=1');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/user/:id', () => {
    it('returns full user info for admin user', async () => {
      const res = await request(server)
        .get(`/api/user/${FIXTURES.users.admin.id}`)
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('user');
      expect(res.body).toHaveProperty('finance');
      expect(res.body).toHaveProperty('preferences');
      expect(res.body.user.id).toBe(FIXTURES.users.admin.id);
      expect(res.body.user).toHaveProperty('full_name');
      expect(res.body.user).toHaveProperty('identification');
      expect(res.body.user).toHaveProperty('email');
      expect(res.body.user).toHaveProperty('role');
      expect(res.body.user).toHaveProperty('role_display');
    });

    it('returns full info for id=-1 (current user)', async () => {
      const res = await request(server)
        .get('/api/user/-1')
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('user');
      expect(res.body.user.id).toBe(FIXTURES.users.admin.id);
    });

    it('finance has last_modified as Spanish date string', async () => {
      const res = await request(server)
        .get(`/api/user/${FIXTURES.users.admin.id}`)
        .set(adminAuth());
      expect(res.status).toBe(200);
      // last_modified should be a Spanish locale string, e.g. "10 feb. 2020"
      expect(typeof res.body.finance.last_modified).toBe('string');
      expect(res.body.finance.last_modified).toMatch(/\d+ \w+\.? \d{4}/);
    });

    it('returns 404 for non-existent user', async () => {
      const res = await request(server)
        .get('/api/user/999999')
        .set(adminAuth());
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/user (create)', () => {
    const uniqueId = Date.now();

    it('returns 403 for president (only admin can create users)', async () => {
      const res = await request(server)
        .post('/api/user')
        .set(presidentAuth())
        .send({
          identification: uniqueId,
          role: 3,
          first_name: 'Test',
          last_name: 'User',
          email: `test_${uniqueId}@example.com`,
        });
      expect(res.status).toBe(403);
    });

    it('returns 409 for duplicate email', async () => {
      const res = await request(server)
        .post('/api/user')
        .set(adminAuth())
        .send({
          identification: uniqueId + 1,
          role: 3,
          first_name: 'Test',
          last_name: 'User',
          email: FIXTURES.users.admin.email, // duplicate email
        });
      expect(res.status).toBe(409);
    });

    it('returns 409 for duplicate identification', async () => {
      const res = await request(server)
        .post('/api/user')
        .set(adminAuth())
        .send({
          identification: FIXTURES.users.admin.identification, // duplicate
          role: 3,
          first_name: 'Test',
          last_name: 'User',
          email: `unique_${uniqueId}@example.com`,
        });
      expect(res.status).toBe(409);
    });
  });

  describe('PATCH /api/user/:id (update)', () => {
    it('admin can update own personal info', async () => {
      const res = await request(server)
        .patch(`/api/user/${FIXTURES.users.admin.id}`)
        .set(adminAuth())
        .send({
          type: 'personal',
          personal: {
            first_name: FIXTURES.users.admin.firstName,
            last_name: FIXTURES.users.admin.lastName,
            email: FIXTURES.users.admin.email,
            identification: FIXTURES.users.admin.identification,
            role: FIXTURES.users.admin.role,
          },
        });
      expect(res.status).toBe(200);
    });

    it('admin can update own preferences', async () => {
      const res = await request(server)
        .patch(`/api/user/${FIXTURES.users.admin.id}`)
        .set(adminAuth())
        .send({
          type: 'preferences',
          preferences: {
            notifications: false,
            primary_color: '#800000',
            secondary_color: '#c83737',
          },
        });
      expect(res.status).toBe(200);
    });

    it('president can update finance (UserDetailView PATCH allows role <= 3)', async () => {
      const res = await request(server)
        .patch(`/api/user/${FIXTURES.users.president.id}`)
        .set(presidentAuth())
        .send({
          type: 'finance',
          finance: {
            contributions: 0,
            balance_contributions: 0,
            total_quota: 0,
            utilized_quota: 0,
          },
        });
      expect(res.status).toBe(200);
    });
  });

  describe('POST /api/user/birthdates', () => {
    it('returns list of user birthdates', async () => {
      const res = await request(server)
        .post('/api/user/birthdates')
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('POST /api/user/power', () => {
    it('can get power requests (requestee type)', async () => {
      const res = await request(server)
        .post('/api/user/power')
        .set(adminAuth())
        .send({ type: 'get', obj: 'requestee', page: 1 });
      expect(res.status).toBe(200);
    });

    it('can get power requests (requested type)', async () => {
      const res = await request(server)
        .post('/api/user/power')
        .set(adminAuth())
        .send({ type: 'get', obj: 'requested', page: 1 });
      expect(res.status).toBe(200);
    });
  });
});
