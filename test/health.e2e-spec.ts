import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { NEST_APPLICATION_OPTIONS } from '../src/bootstrap';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';

describe('Phase 0 application boot', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication(NEST_APPLICATION_OPTIONS);
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

  it('ships no Phase 3-8 business endpoints yet', async () => {
    // Users, loans, activities, saving accounts and files are Phases 3-8.
    for (const path of [
      '/api/loan',
      '/api/user',
      '/api/activity/year',
      '/api/saving-account',
      '/api/file',
      '/api/admin',
    ]) {
      await request(app.getHttpServer()).get(path).expect(404);
    }
  });

  it('exposes the Phase 2 notification route, guarded', async () => {
    // A route that exists answers 401 without credentials; one that does not answers 404.
    // The @All() fallback is what makes a GET reach the guard at all — without it Express
    // would 404 and v1's 403-for-an-undeclared-method could never be reproduced.
    await request(app.getHttpServer()).get('/api/notification/subscribe').expect(401);
    await request(app.getHttpServer()).post('/api/notification/subscribe').expect(401);
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
