import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AuthModule } from '../src/auth/auth.module';
import { Role } from '../src/auth/permissions/roles';
import { V1_ROLE_MATRIX } from '../src/auth/permissions/v1-role-matrix.fixture';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { AppConfigModule } from '../src/config/config.module';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  MATRIX_BASE_PATH,
  MATRIX_CONTROLLERS,
  UNREGISTERED_CONTROLLER,
} from './support/matrix-controllers';
import {
  authHeader,
  obtainToken,
  resetDatabase,
  seedUser,
  seedUserWithoutProfile,
} from './support/abstract-test';

/**
 * Phase 1 parity criterion, end to end:
 *
 * > **Full role matrix:** 14 view classes × each method in `list_permissions` × 4 roles →
 * > identical allow/deny. Plus an authenticated request to a rule-less route → 403 in both.
 *
 * The expectations come from `src/auth/permissions/v1-role-matrix.fixture.ts`, which is a
 * capture of 280 real requests against `Django==2.2.27` + `djangorestframework==3.11.2`
 * running v1's `REST_FRAMEWORK` settings and `fondo_api/permissions.py` verbatim. This suite
 * replays all 280 through the v2 HTTP stack: real controllers, real global guards, real
 * database, real tokens obtained from `POST /api-token-auth`.
 *
 * `permission-matrix.spec.ts` covers the same table at the unit level. Both exist on
 * purpose: the unit test pins the *rule*, this one pins the *wiring* — that the guards are
 * registered globally, in DRF's order, and that nothing between the router and the handler
 * quietly changes the answer.
 */
describe('Phase 1 — the full v1 role matrix', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const tokens = new Map<Role, string>();

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      // AuthModule contributes both APP_GUARDs, so the matrix controllers are guarded
      // exactly as the Phase 3-8 controllers will be.
      imports: [AppConfigModule, PrismaModule, AuthModule],
      controllers: [...MATRIX_CONTROLLERS, UNREGISTERED_CONTROLLER],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();

    prisma = app.get(PrismaService);
    await resetDatabase(prisma);

    for (const role of [Role.ADMIN, Role.PRESIDENT, Role.TREASURER, Role.MEMBER]) {
      const email = `role${role}@mail.com`;
      await seedUser(prisma, { email, identification: BigInt(1000 + role), role });
      tokens.set(role, await obtainToken(app, email));
    }
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await app.close();
  });

  function send(method: string, path: string, token?: string): request.Test {
    const agent = request(app.getHttpServer());
    const call = {
      GET: agent.get.bind(agent),
      POST: agent.post.bind(agent),
      PATCH: agent.patch.bind(agent),
      PUT: agent.put.bind(agent),
      DELETE: agent.delete.bind(agent),
    }[method];
    if (call === undefined) {
      throw new Error(`unsupported method ${method}`);
    }
    const req = call(path);
    return token === undefined ? req : req.set(authHeader(token));
  }

  describe('280 captured v1 outcomes, replayed', () => {
    it.each(V1_ROLE_MATRIX.map((row) => [row.view, row.method, row.role, row.allowed] as const))(
      '%s %s as role %d -> allowed=%s',
      async (view, method, role, allowed) => {
        const response = await send(method, `${MATRIX_BASE_PATH}/${view}`, tokens.get(role));

        if (allowed) {
          expect(response.status).toBe(200);
          expect(response.body).toEqual({ ok: true });
        } else {
          expect(response.status).toBe(403);
          expect(response.body).toEqual({
            detail: 'You do not have permission to perform this action.',
          });
          // PermissionDenied carries no challenge; only 401s do.
          expect(response.headers['www-authenticate']).toBeUndefined();
        }
      },
    );
  });

  describe('a route with no rule fails closed', () => {
    it.each([Role.ADMIN, Role.PRESIDENT, Role.TREASURER, Role.MEMBER])(
      'denies role %d on a controller with no @V1View',
      async (role) => {
        const response = await send(
          'GET',
          `${MATRIX_BASE_PATH}/UnregisteredView`,
          tokens.get(role),
        );
        expect(response.status).toBe(403);
        expect(response.body).toEqual({
          detail: 'You do not have permission to perform this action.',
        });
      },
    );

    it('denies every method on it, not just GET', async () => {
      for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
        const response = await send(
          method,
          `${MATRIX_BASE_PATH}/UnregisteredView`,
          tokens.get(Role.ADMIN),
        );
        expect(response.status).toBe(403);
      }
    });
  });

  describe('unauthenticated requests to guarded routes', () => {
    it('401 with NotAuthenticated, not 403', async () => {
      const response = await send('GET', `${MATRIX_BASE_PATH}/LoanView`);
      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        detail: 'Authentication credentials were not provided.',
      });
      expect(response.headers['www-authenticate']).toBe('Token');
    });

    it('401 even where the rule would have allowed every role', async () => {
      const response = await send('GET', `${MATRIX_BASE_PATH}/SavingAccountView`);
      expect(response.status).toBe(401);
    });

    it('401 on an unregistered route too — authentication is checked first', async () => {
      const response = await send('GET', `${MATRIX_BASE_PATH}/UnregisteredView`);
      expect(response.status).toBe(401);
    });
  });

  describe('a user with no fondo_api_userprofile row', () => {
    it('is denied every guarded route with a 403', async () => {
      const orphanId = await seedUserWithoutProfile(prisma, 'matrix-orphan@mail.com');
      const key = 'e'.repeat(40);
      await prisma.authToken.create({
        data: { key, user_id: orphanId, created: new Date() },
      });

      // v1: `request.user.userprofile` raises, the bare `except` returns False -> 403.
      for (const view of ['LoanView', 'SavingAccountView', 'FileView']) {
        const response = await send('GET', `${MATRIX_BASE_PATH}/${view}`, key);
        expect(response.status).toBe(403);
      }
    });
  });
});
