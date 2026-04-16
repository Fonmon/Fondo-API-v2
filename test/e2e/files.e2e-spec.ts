import * as request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { acquireApp, releaseApp, FIXTURES, adminAuth, presidentAuth } from './helpers/setup';

describe('Files (e2e)', () => {
  let app: INestApplication;
  let server: any;

  beforeAll(async () => {
    app = await acquireApp();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await releaseApp();
  });

  describe('GET /api/file', () => {
    it('returns list of all files', async () => {
      const res = await request(server)
        .get('/api/file')
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('returns files with expected fields', async () => {
      const res = await request(server)
        .get('/api/file')
        .set(adminAuth());
      expect(res.status).toBe(200);
      if (res.body.length > 0) {
        const file = res.body[0];
        expect(file).toHaveProperty('id');
        expect(file).toHaveProperty('display_name');
        expect(file).toHaveProperty('type_display');
      }
    });

    it('filters by type=0 (proceedings)', async () => {
      const res = await request(server)
        .get('/api/file?type=0')
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('returns 401 without auth', async () => {
      const res = await request(server).get('/api/file');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/file/:id', () => {
    it('returns signed URL for existing file', async () => {
      const res = await request(server)
        .get(`/api/file/${FIXTURES.files.existing.id}`)
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('url');
      expect(typeof res.body.url).toBe('string');
    });

    it('returns 404 for non-existent file', async () => {
      const res = await request(server)
        .get('/api/file/999999')
        .set(adminAuth());
      expect(res.status).toBe(404);
    });
  });

  describe('Role enforcement', () => {
    it('president cannot POST /api/file (only admin)', async () => {
      const res = await request(server)
        .post('/api/file')
        .set(presidentAuth())
        .field('name', 'test')
        .field('type', '0');
      expect(res.status).toBe(403);
    });
  });
});
