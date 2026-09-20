import { Controller, Delete, Get, Post, type INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AuthModule } from '../src/auth/auth.module';
import { V1View } from '../src/auth/decorators/v1-view.decorator';
import { Role } from '../src/auth/permissions/roles';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { DJANGO_URL_CONF } from '../src/common/http/django-url-conf';
import { DjangoUrlResolverMiddleware } from '../src/common/http/django-url-resolver.middleware';
import { AppConfigModule } from '../src/config/config.module';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { authHeader, obtainToken, resetDatabase, seedUser } from './support/abstract-test';

/**
 * Condition **C20** / finding **S2**, reproduced on the exact routes that will make it live.
 *
 * ## The trap
 *
 * v1 has four patterns under `/api/user/`, in this order (`fondo_api/urls.py:20-23`), with
 * different rules (`fondo_api/permissions.py`):
 *
 * ```
 * ^api/user/?$                       UserView          POST 0   GET 3   PATCH [0,2]
 * ^api/user/(?P<app>-?[a-zA-Z]+)$    UserAppsView      POST 3            <- no DELETE at all
 * ^api/user/(?P<id>-?[0-9]+)$        UserDetailView    GET 3    PATCH 3  DELETE 0
 * ^api/user/activate/(?P<id>[0-9]+)$ UserActivateView  permission_classes = []
 * ```
 *
 * Django picks the view by **first pattern that matches**, so `DELETE /api/user/power` is
 * `UserAppsView` — confirmed on the live v1, whose `Allow: POST, OPTIONS` on that path names
 * the view that answered — and `UserAppsView` declares no `DELETE`, so `APIRolePermission`'s
 * bare `except` denies it for **every** role including ADMIN.
 *
 * Express picks by **declaration order with unconstrained `:params`**. A Phase 3 controller
 * that declares `@Delete(':id')` before `@Post(':app')` therefore hands `/api/user/power` to
 * `UserDetailView.DELETE`, whose rule is `role <= 0` — ADMIN-allowed. A routing detail would
 * have become an authorisation decision, and it would have surfaced as a **successful soft
 * delete**, not as a 404.
 *
 * ## What this file mounts
 *
 * The mis-ordering, deliberately: `UserDetailProbeController` is registered **first**, so
 * Express matches its `:id` route for `/api/user/power`. Before C20 the guard read
 * `@V1View('UserDetailView')` off that route and allowed an ADMIN through. It now reads the
 * view the URL table resolved and fails closed.
 *
 * ⚠️ Do not "fix" the declaration order here — the wrong order *is* the fixture.
 */
@V1View('UserDetailView')
@Controller('api/user')
class UserDetailProbeController {
  /** `UserDetailView.delete` — `list_permissions['UserDetailView']['DELETE'] = 0`. */
  @Delete(':id')
  remove(): { view: string } {
    return { view: 'UserDetailView' };
  }

  /** `UserDetailView.get` — rule 3, allowed for every role. */
  @Get(':id')
  read(): { view: string } {
    return { view: 'UserDetailView' };
  }
}

@V1View('UserAppsView')
@Controller('api/user')
class UserAppsProbeController {
  /** `UserAppsView.post` — rule 3. The view v1 resolves `/api/user/power` to. */
  @Post(':app')
  apps(): { view: string } {
    return { view: 'UserAppsView' };
  }
}

describe('C20 — the guard binds to the resolved v1 view, not to the Nest route', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const tokens = new Map<Role, string>();

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppConfigModule, PrismaModule, AuthModule],
      // Order matters and is the fixture: `:id` first, so Express matches it for `power`.
      controllers: [UserDetailProbeController, UserAppsProbeController],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new ApiExceptionFilter());
    // The v1 table with `dispatch` stripped — real v1 URLs, resolved to real v1 views, but
    // routed the way Express would route them **without** the internal-path rewrite the two
    // `/api/user/<x>` patterns now carry. That rewrite is what makes the production
    // controllers immune to this class of mistake (see `DjangoUrlPattern.dispatch`); this
    // suite is about the guard that catches it when nothing else does, so it deliberately
    // recreates the unprotected shape.
    const resolver = new DjangoUrlResolverMiddleware(
      DJANGO_URL_CONF.map(({ regex, view, drf }) => ({ regex, view, drf })),
    );
    app.use(resolver.use.bind(resolver));
    await app.init();

    prisma = app.get(PrismaService);
    await resetDatabase(prisma);

    for (const role of [Role.ADMIN, Role.MEMBER]) {
      const email = `viewbind${role}@mail.com`;
      await seedUser(prisma, { email, identification: BigInt(2000 + role), role });
      tokens.set(role, await obtainToken(app, email));
    }
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await app.close();
  });

  it('refuses DELETE /api/user/power for ADMIN — v1 resolves it to UserAppsView (deny-all)', async () => {
    // ⚠️ THE REGRESSION. Before C20 this was 200 `{"view":"UserDetailView"}` — the wrong
    // view's DELETE rule, applied by Express's declaration order.
    const response = await request(app.getHttpServer())
      .delete('/api/user/power')
      .set(authHeader(tokens.get(Role.ADMIN)!));

    expect(response.status).toBe(500);
    expect(response.body).not.toEqual({ view: 'UserDetailView' });
  });

  it('refuses it for a MEMBER too — the disagreement is checked before the role rule', async () => {
    const response = await request(app.getHttpServer())
      .delete('/api/user/power')
      .set(authHeader(tokens.get(Role.MEMBER)!));

    expect(response.status).toBe(500);
  });

  it('still 401s an unauthenticated caller first, as DRF does', async () => {
    const response = await request(app.getHttpServer()).delete('/api/user/power');

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      detail: 'Authentication credentials were not provided.',
    });
  });

  it('allows DELETE /api/user/5 for ADMIN — table and route agree on UserDetailView', async () => {
    const response = await request(app.getHttpServer())
      .delete('/api/user/5')
      .set(authHeader(tokens.get(Role.ADMIN)!));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ view: 'UserDetailView' });
  });

  it('403s DELETE /api/user/5 for a MEMBER — UserDetailView.DELETE is role <= 0', async () => {
    const response = await request(app.getHttpServer())
      .delete('/api/user/5')
      .set(authHeader(tokens.get(Role.MEMBER)!));

    expect(response.status).toBe(403);
  });

  it('allows POST /api/user/power for a MEMBER — UserAppsView.POST is rule 3', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/user/power')
      .set(authHeader(tokens.get(Role.MEMBER)!));

    // 201 is Nest's default for POST; the probe controller does not set @HttpCode, and the
    // status is not what this suite is about.
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ view: 'UserAppsView' });
  });

  it('allows GET /api/user/-1 — the sentinel id, `-?[0-9]+`, still UserDetailView', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/user/-1')
      .set(authHeader(tokens.get(Role.MEMBER)!));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ view: 'UserDetailView' });
  });

  it('refuses GET /api/user/-power — `-?[a-zA-Z]+` is UserAppsView, which has no GET', async () => {
    // v1: `Allow: POST, OPTIONS` on `/api/user/-power`, measured. Express matches `:id`.
    const response = await request(app.getHttpServer())
      .get('/api/user/-power')
      .set(authHeader(tokens.get(Role.MEMBER)!));

    expect(response.status).toBe(500);
  });

  it('404s a path outside the table before any of this — the layer is still fail-closed', async () => {
    const response = await request(app.getHttpServer())
      .delete('/api/user/power/extra')
      .set(authHeader(tokens.get(Role.ADMIN)!));

    expect(response.status).toBe(404);
  });
});
