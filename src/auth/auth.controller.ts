import { All, Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { DrfNoRequestData } from '../common/http/drf-parser.interceptor';
import { DrfException } from '../common/http/drf.exception';
import { AuthService, type AuthTokenResponse } from './auth.service';
import { Public } from './decorators/public.decorator';

/**
 * `rest_framework.authtoken.views.ObtainAuthToken`, mounted by v1 at
 * `url(r'^api-token-auth/?$', views.obtain_auth_token, name='obtain_auth_token')`.
 *
 * The trailing slash is optional in v1's regex; Express's default non-strict routing gives
 * `/api-token-auth/` the same treatment, and the e2e suite pins both forms.
 *
 * `ObtainAuthToken` sets `permission_classes = ()` but leaves `authentication_classes` at
 * the project default, so `@Public()` is the exact analogue: no permission check, but
 * `TokenAuthGuard` still runs and a malformed `Authorization` header still 401s.
 */
@Controller()
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /** `Response({'token': token.key})` — DRF's default 200, not 201. */
  @Public()
  @Post('api-token-auth')
  @HttpCode(HttpStatus.OK)
  login(@Body() body: unknown): Promise<AuthTokenResponse> {
    return this.authService.login(body);
  }

  /**
   * DRF's `http_method_not_allowed`, which Nest would otherwise render as a 404.
   *
   * `ObtainAuthToken` defines only `post`, so `GET`/`PUT`/`PATCH`/`DELETE` on this path give
   * `405 {"detail": "Method \"GET\" not allowed."}` with `Allow: POST, OPTIONS`. Verified
   * against the pinned v1 stack.
   *
   * Declared **after** {@link login} so Express matches the POST route first; `@All` would
   * otherwise swallow it.
   *
   * ⚠️ Registered deviation P1-D2: v1 answers `OPTIONS` with DRF's browsable-API metadata
   * document (`200`), not a 405. v2 does not ship the browsable API, so OPTIONS lands here.
   *
   * `@DrfNoRequestData()` closes review condition **C10**: `APIView.dispatch` resolves
   * `http_method_not_allowed` and raises without ever touching `request.data`, so a `PUT`
   * carrying a `text/plain` body is a **405**, not the 415 the parser interceptor would
   * otherwise raise first.
   */
  @Public()
  @DrfNoRequestData()
  @All('api-token-auth')
  methodNotAllowed(@Req() request: Request): never {
    throw DrfException.methodNotAllowed(request.method, 'POST, OPTIONS');
  }
}
