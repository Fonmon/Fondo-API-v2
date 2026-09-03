import {
  All,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { V1View } from '../auth/decorators/v1-view.decorator';
import { ApiException } from '../common/http/api.exception';
import { getUploadedFiles } from '../common/http/django-multipart';
import { DrfNoRequestData } from '../common/http/drf-parser.interceptor';
import { DrfException } from '../common/http/drf.exception';
import type { PageEnvelope, UnpaginatedEnvelope } from '../common/http/pagination';
import type { UserProfileDto } from './dto/user.serializers';
import { PythonKeyError } from './python-obj';
import { UserService } from './user.service';

/**
 * `fondo_api/views/user.py:UserView`, mounted by `url(r'^api/user/?$', …, name='view_user')`.
 *
 * ```python
 * def post(self, request):
 *     state, msg = user_service.create_user(request.data)
 *     if state: return Response(status=status.HTTP_201_CREATED)
 *     return Response({'message': msg}, status=status.HTTP_409_CONFLICT)
 *
 * def get(self, request):
 *     page = None
 *     if request.query_params.get('page') is not None:
 *         page = int(request.query_params.get('page', '1'))
 *     if page is not None and page <= 0:
 *         return Response({'message': 'Page number must be greater than 0'}, 400)
 *     return Response(user_service.get_users(page), status=status.HTTP_200_OK)
 *
 * @parser_classes((MultiPartParser,))
 * def patch(self, request):
 *     user_service.bulk_update_users(request.data)
 *     return Response(status=status.HTTP_200_OK)
 * ```
 *
 * `list_permissions['UserView']` is `POST 0`, `GET 3`, `PATCH [0, 2]` — creating a member is
 * ADMIN-only, the monthly TSV is ADMIN or TREASURER, and any member may list.
 */
@V1View('UserView')
@Controller('api/user')
export class UserController {
  constructor(private readonly users: UserService) {}

  /** `UserView.post` — `Response(status=201)`, i.e. **201 with a zero-byte body**. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: unknown): Promise<void> {
    await this.users.createUser(body);
  }

  /**
   * `UserView.get`.
   *
   * ⚠️ The `page` parsing is v1's, warts included. `int(request.query_params.get('page','1'))`
   * runs only when the key is **present**, so:
   *
   *  * no `page` at all → the unpaginated `{'list': [...]}` envelope, no `count`;
   *  * `?page=` (empty) → `int('')` → `ValueError` → **500**, not a 400;
   *  * `?page=abc` → **500**;
   *  * `?page=0` or a negative → **400** `{"message": "Page number must be greater than 0"}`.
   *
   * ⚠️ A repeated `?page=1&page=2` is `QueryDict.get`, which returns the **last** value.
   */
  @Get()
  @HttpCode(HttpStatus.OK)
  async list(
    @Query('page') page?: string | string[],
  ): Promise<PageEnvelope<UserProfileDto> | UnpaginatedEnvelope<UserProfileDto>> {
    const raw = lastQueryValue(page);
    if (raw === undefined) {
      return this.users.getUsers(null);
    }
    const parsed = pythonInt(raw);
    if (parsed <= 0) {
      throw ApiException.withMessage(HttpStatus.BAD_REQUEST, 'Page number must be greater than 0');
    }
    return this.users.getUsers(parsed);
  }

  /**
   * `UserView.patch` — the treasurer's monthly TSV.
   *
   * ## ⚠️ `@parser_classes((MultiPartParser,))` on this handler is a **no-op**, and v2 must
   * reproduce that rather than the decorator's apparent intent
   *
   * `rest_framework.decorators.parser_classes` is written for **function**-based views: it
   * sets `func.parser_classes` on the decorated callable. Applied to a *method* of an
   * `APIView` (`views/user.py:36`) it decorates the unbound function, and `APIView.dispatch`
   * never looks there — `self.parser_classes` still resolves to
   * `DEFAULT_PARSER_CLASSES`. So this route accepts JSON, form and multipart exactly like
   * every other one.
   *
   * Measured on the live v1, which is why this is stated rather than argued:
   *
   * | `Content-Type` | v1 |
   * |---|---|
   * | `application/json` | **500** (`<h1>Server Error (500)</h1>`) — the body parses to `{}` and `obj['file']` raises `KeyError` |
   * | `application/x-www-form-urlencoded` | **500**, same reason |
   * | `multipart/form-data` with no `file` part | **500**, same reason |
   * | `text/plain` | **415** — not in the *default* parser list either |
   *
   * An earlier version of this controller carried `@DrfParsers(MULTIPART)` and answered 415
   * for JSON. That was wrong in the one direction that matters: it refused a request v1
   * accepts-then-500s on, which a client could tell apart.
   *
   * ⚠️ **The same decorator is misused twice more** — `LoanView.patch` (`views/loan.py:49`)
   * and `FileView.post` (`views/file.py:15`). Phases 4 and 8 must not "restore" the
   * narrowing there either.
   */
  @Patch()
  @HttpCode(HttpStatus.OK)
  async bulkUpdate(@Req() request: Request): Promise<void> {
    await this.users.bulkUpdateUsers(readUploadedFile(request, 'file'));
  }

  /**
   * Keeps the unimplemented methods inside the guarded pipeline, so they 403 as in v1 rather
   * than 404ing in Nest's router (plan §4 rule 12).
   *
   * ⚠️ In practice this handler is unreachable on a guarded DRF view: `APIView.initial()`
   * checks permissions **before** `dispatch` resolves a handler, and every method missing from
   * `list_permissions` is denied there. So `PUT /api/user` is a 403 in v1, not a 405. The
   * route exists only to give {@link RolesGuard} something to guard.
   */
  @DrfNoRequestData()
  @All()
  methodNotAllowed(@Req() request: Request): never {
    throw DrfException.methodNotAllowed(request.method, 'GET, POST, PATCH, HEAD, OPTIONS');
  }
}

/** `QueryDict.get` — the **last** value of a repeated key, `undefined` when absent. */
export function lastQueryValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value.length === 0 ? undefined : value[value.length - 1];
  }
  return value;
}

/**
 * CPython's `int(str)`: leading/trailing whitespace is allowed, an optional sign is allowed,
 * everything else raises `ValueError` — which `UserView.get` does not catch, so it is a 500.
 */
export function pythonInt(raw: string): number {
  const trimmed = raw.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) {
    throw new Error(`ValueError: invalid literal for int() with base 10: '${raw}'`);
  }
  return Number(trimmed);
}

/**
 * `request.data['<field>']` for the multipart uploads, i.e. Django's `request.FILES`.
 *
 * A missing part is v1's `KeyError` — a 500 — not a 400.
 */
export function readUploadedFile(request: Request, field: string): Buffer {
  const match = getUploadedFiles(request).find((file) => file.fieldname === field);
  if (match === undefined) {
    throw new PythonKeyError(field);
  }
  return match.buffer;
}
