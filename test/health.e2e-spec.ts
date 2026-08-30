import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';

describe('Phase 0 application boot', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('boots against the real schema and reports a healthy database', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200);
    expect(response.body).toEqual({ status: 'ok', database: 'up' });
  });

  it('ships no business endpoints yet', async () => {
    // Users, loans, activities, saving accounts, files and notifications are Phases 2-8.
    for (const path of [
      '/api/loan',
      '/api/user',
      '/api/activity/year',
      '/api/saving-account',
      '/api/file',
      '/api/admin',
      '/api/notification/subscribe',
    ]) {
      await request(app.getHttpServer()).get(path).expect(404);
    }
  });

  it('exposes exactly one Phase 1 route: POST /api-token-auth', async () => {
    // Phase 1 added it, so it is no longer a 404. A GET is DRF's 405, not a 404, because
    // the URL resolves and only the method is wrong (`AuthController.methodNotAllowed`).
    await request(app.getHttpServer()).get('/api-token-auth').expect(405);
  });

  it('renders an unknown route through the parity exception filter', async () => {
    const response = await request(app.getHttpServer()).get('/definitely-not-a-route');
    expect(response.status).toBe(404);
    // v1's convention is {'message': ...}; Nest's default envelope must not leak.
    expect(response.body).toHaveProperty('message');
    expect(response.body).not.toHaveProperty('statusCode');
    expect(response.body).not.toHaveProperty('error');
  });
});
