import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { NEST_APPLICATION_OPTIONS } from '../src/bootstrap';
import { Public } from '../src/auth/decorators/public.decorator';
import {
  DJANGO_URL_CONF,
  DJANGO_URL_CONF_TOKEN,
  type DjangoUrlPattern,
} from '../src/common/http/django-url-conf';
import { MAX_SAFE_BIGINT } from '../src/common/http/json-bigint';

/**
 * Reviewer finding S2 / plan §4 rule 5b — end to end.
 *
 * `json-bigint.spec.ts` pins the *decision* (a bare JSON number, as DRF's `IntegerField`
 * renders `BigIntegerField`). This suite pins the *wiring*: that `AppModule` alone is enough,
 * so a Phase 3 controller returning `UserFinance` cannot 500 with
 * `TypeError: Do not know how to serialize a BigInt`.
 *
 * The probe controller stands in for Phase 3's `GET /api/user/<id>`, whose `finance` block is
 * six BigInt columns.
 */
@Controller('__bigint')
class BigIntProbeController {
  @Public()
  @Get('finance')
  finance(): Record<string, unknown> {
    return {
      list: [{ id: 1, contributions: 1_000_000n, available_quota: 0n }],
      num_pages: 1,
      count: 1,
      identification: 1_098_765_432n,
    };
  }

  @Public()
  @Get('overflow')
  overflow(): Record<string, unknown> {
    return { value: MAX_SAFE_BIGINT + 1n };
  }
}

/**
 * The synthetic stand-in for Phase 3's `GET /api/user/<id>`; not a v1 URL.
 *
 * `view: null` because there is no v1 view behind it (condition **C20** narrowed the field
 * to the 21 real view names). Both probe routes are therefore `@Public()` — a `null` view can
 * carry no permission rule, and `RolesGuard` 500s a guarded route that resolves to one.
 */
const PROBE_ROUTE: DjangoUrlPattern = {
  regex: /^__bigint\/[a-z]+$/,
  view: null,
  drf: null,
};

describe('Phase 0 — BigInt responses (plan rule 5b)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [BigIntProbeController],
    })
      // `DjangoUrlResolverMiddleware` is fail-closed: a path absent from v1's URL table never
      // reaches a controller (condition C9). This probe is synthetic, so it has to be
      // declared — which is the point of the token being overridable and nothing else being.
      .overrideProvider(DJANGO_URL_CONF_TOKEN)
      .useValue([...DJANGO_URL_CONF, PROBE_ROUTE] satisfies DjangoUrlPattern[])
      .compile();

    app = moduleFixture.createNestApplication(NEST_APPLICATION_OPTIONS);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('renders every BigInt as a bare JSON number, never a quoted string', async () => {
    const response = await request(app.getHttpServer()).get('/__bigint/finance').expect(200);

    // Asserted on the raw text: `response.body` would have already parsed 1000000 and
    // "1000000" into indistinguishable-looking values in a loose comparison.
    expect(response.text).toBe(
      '{"list":[{"id":1,"contributions":1000000,"available_quota":0}],' +
        '"num_pages":1,"count":1,"identification":1098765432}',
    );
    expect(response.text).not.toContain('"1000000"');
  });

  it('fails loudly rather than losing precision above 2^53', async () => {
    const response = await request(app.getHttpServer()).get('/__bigint/overflow');
    expect(response.status).toBe(500);
  });
});
