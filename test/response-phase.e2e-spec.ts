import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { NEST_APPLICATION_OPTIONS } from '../src/bootstrap';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { DjangoStack, onBeforeHeaders, type DjangoDepth } from '../src/common/http/before-headers';
import { patchVaryHeaders } from '../src/common/http/django-cors.middleware';
import { SQS_CLIENT } from '../src/notifications/sqs.client';

/**
 * Condition **C21** / finding **S1**, end to end — the cell the reviewer asked for:
 *
 * > an e2e cell that registers a probe middleware at slot 2 and asserts its hook runs
 * > **after** the CORS hook. There is no such cell because there is no such middleware yet —
 * > which is precisely why this needs closing before Phase 3 rather than during it.
 *
 * The probe stands in for `SessionMiddleware` (slot 2) and for `PasswordResetView`'s
 * view-level `csrf_protect`, the two things Phase 3 adds that patch `Cookie` into `Vary` from
 * two different depths. It is mounted with `app.use()` *before* `init()`, so its request phase
 * runs above everything `AppModule` registers and its hook is therefore registered **first** —
 * the worst case for a FIFO model, and the case the depth model has to get right.
 *
 * Both expected values were measured on the live v1 (`docs/parity-phase-2.md` §R3.6):
 *
 * | route | `Vary` | who added `Cookie` |
 * |---|---|---|
 * | `GET /password_reset/` | `Cookie, Origin` | view-level `csrf_protect`, below all eight |
 * | `GET /reset/<uid>/set-password/` | `Origin, Cookie` | `SessionMiddleware`, slot 2 |
 *
 * A FIFO response phase produces `Cookie` before `Origin` in **both** cases, so this suite
 * fails against the pre-C21 implementation on the slot-2 cell and passes on the view one.
 */
describe('C21 — the response phase runs bottom-up, ordered by v1 MIDDLEWARE depth', () => {
  let app: INestApplication<App>;
  const sqs = { send: jest.fn() };

  /** `X-Probe-Depth: <n>` picks the slot the probe pretends to live at. */
  function varyProbe(request_: Request, response: Response, next: NextFunction): void {
    const header = request_.headers['x-probe-depth'];
    if (typeof header === 'string') {
      onBeforeHeaders(response, Number(header) as DjangoDepth, (finished) => {
        patchVaryHeaders(finished, ['Cookie']);
      });
    }
    next();
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SQS_CLIENT)
      .useValue(sqs)
      .compile();

    app = moduleFixture.createNestApplication(NEST_APPLICATION_OPTIONS);
    app.useGlobalFilters(new ApiExceptionFilter());
    // Before `init()`, so the probe's *request* phase is the outermost of all — and its hook
    // is the first registered. Under FIFO it would therefore also run first.
    app.use(varyProbe);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  /** `Vary: Accept` is set eagerly by the resolver, so the merged value shows the whole order. */
  async function varyFor(depth: DjangoDepth): Promise<string | undefined> {
    const response = await request(app.getHttpServer())
      .post('/api/notification/subscribe')
      .set('X-Probe-Depth', String(depth));

    expect(response.status).toBe(401);
    return response.headers['vary'];
  }

  it('a slot-2 hook runs AFTER the CORS hook — `Origin` before `Cookie`', async () => {
    // ⚠️ THE REGRESSION CELL. FIFO gives `Accept, Cookie, Origin` here, which is the wrong
    // one of the two orders v1 produces.
    expect(await varyFor(DjangoStack.SESSION)).toBe('Accept, Origin, Cookie');
  });

  it('a view-level hook runs BEFORE the CORS hook — `Cookie` before `Origin`', async () => {
    expect(await varyFor(DjangoStack.VIEW)).toBe('Accept, Cookie, Origin');
  });

  it('a slot-4 hook (CsrfViewMiddleware) orders like slot 2, not like the view', async () => {
    expect(await varyFor(DjangoStack.CSRF)).toBe('Accept, Origin, Cookie');
  });

  it('leaves `Vary: Accept, Origin` alone when the probe is silent — the control', async () => {
    const response = await request(app.getHttpServer()).post('/api/notification/subscribe');

    expect(response.status).toBe(401);
    expect(response.headers['vary']).toBe('Accept, Origin');
  });

  describe('skip is scoped to “below me”', () => {
    it('the APPEND_SLASH 301 still runs a slot-2 hook', async () => {
      // `CommonMiddleware` sits at slot 3 and *returns* its redirect, so slots 2 and 1 still
      // decorate it. Nothing below slot 3 does: no X-Frame-Options, no Access-Control-*.
      const response = await request(app.getHttpServer())
        .post('/password_reset')
        .set('X-Probe-Depth', String(DjangoStack.SESSION))
        .set('Origin', 'http://x.test');

      expect(response.status).toBe(301);
      expect(response.headers['vary']).toBe('Cookie');
      expect(response.headers['x-frame-options']).toBeUndefined();
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('the 301 does not run a view-level hook — that is below slot 3', async () => {
      const response = await request(app.getHttpServer())
        .post('/password_reset')
        .set('X-Probe-Depth', String(DjangoStack.VIEW));

      expect(response.status).toBe(301);
      expect(response.headers['vary']).toBeUndefined();
    });

    it('the DisallowedHost 400 skips slot 3 as well, so a slot-2 hook is its last survivor', async () => {
      // Raised rather than returned (C19), so slot 3's own response phase never runs either.
      // Supertest cannot forge `Host`, so this drives the same skip through the 301's
      // neighbour: see `http-edge.e2e-spec.ts` for the forged-Host statuses themselves.
      const response = await request(app.getHttpServer())
        .post('/password_reset')
        .set('X-Probe-Depth', String(DjangoStack.COMMON));

      expect(response.status).toBe(301);
      // slot 3 itself is not below slot 3, so it survives the APPEND_SLASH skip.
      expect(response.headers['vary']).toBe('Cookie');
    });
  });
});
