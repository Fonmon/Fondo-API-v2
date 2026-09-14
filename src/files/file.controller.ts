import { All, Controller, Get, HttpStatus, Logger, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { V1View } from '../auth/decorators/v1-view.decorator';
import { ApiException } from '../common/http/api.exception';
import { lastQueryValue } from '../common/http/django-query';
import {
  drfRequestDataGet,
  drfRequestDataHas,
  isMultipartInitFailure,
  isNonAsciiBoundaryFailure,
} from '../common/http/drf-request-data';
import { assertRequestDataParsable, DrfNoRequestData } from '../common/http/drf-parser.interceptor';
import { DrfException } from '../common/http/drf.exception';
import { pythonInt } from '../common/utils/python-obj';
import type { FileDto } from './dto/file.serializers';
import { FileService } from './file.service';

/**
 * `fondo_api/views/file.py:FileView`, mounted by `url(r'^api/file/?$', …, name='view_file')` —
 * trailing slash **optional**.
 *
 * `list_permissions['FileView']` is `POST 0`, `GET 3`: only ADMIN uploads, every member lists.
 */
@V1View('FileView')
@Controller('api/file')
export class FileController {
  private readonly logger = new Logger('fondo_api.views.file');

  constructor(private readonly files: FileService) {}

  /**
   * `FileView.post`.
   *
   * ```python
   * @parser_classes((MultiPartParser,))
   * def post(self, request):
   *     try:
   *         if "name" in request.data and "file" in request.data and "type" in request.data:
   *             file_service.save_file(request.data)
   *             return Response(status=status.HTTP_201_CREATED)
   *         return Response(status=status.HTTP_400_BAD_REQUEST)
   *     except Exception as exception:
   *         logger.error('Exception saving file: %s', exception)
   *         return Response(status=status.HTTP_500_INTERNAL_SERVER_ERROR)
   * ```
   *
   * ⚠️ **No parser narrowing** (plan §4 rule 12b): the decorator is on a method, so it is a
   * no-op, and JSON and form bodies reach the handler.
   *
   * ⚠️ **`request.data` is first touched inside the `try`**, so DRF's lazy parse runs there and
   * its `UnsupportedMediaType` / `ParseError` are caught like anything else. Measured:
   * `text/plain` and malformed JSON are **500**, not 415 / 400. Hence `@DrfNoRequestData()`
   * and an explicit {@link assertRequestDataParsable} inside the `try`.
   *
   * ⚠️ **Except when the multipart parser fails in its constructor** (empty or non-ASCII
   * boundary): v1 double-faults past its own `except` to gunicorn's bare page — see
   * {@link isMultipartInitFailure}. That case is rethrown uncaught, so it loses `Allow` and
   * `Vary` as v1's does.
   *
   * ⚠️ **Presence is checked against DRF's merged view** without building it — a `file` sent as
   * a plain field passes and then 500s on `.content_type`, as in v1 (measurement 2;
   * `common/http/drf-request-data.ts`).
   *
   * v1's branches are bodiless: **201**, **400**, **500**. v2 adds two refusals raised by
   * `FileService.saveFile` before any storage call and re-raised past the `except` below:
   * plan §5 **D47** — **400** `{"message": "Type must be 0 or 1"}` — then **D46** — **409**
   * `{"message": "A file with this name already exists with a different type"}`.
   */
  @DrfNoRequestData()
  @Post()
  async create(@Req() request: Request): Promise<never> {
    let status: HttpStatus;
    try {
      assertRequestDataParsable(request);
      if (
        drfRequestDataHas(request, 'name') &&
        drfRequestDataHas(request, 'file') &&
        drfRequestDataHas(request, 'type')
      ) {
        await this.files.saveFile({
          type: drfRequestDataGet(request, 'type'),
          name: drfRequestDataGet(request, 'name'),
          file: drfRequestDataGet(request, 'file'),
        });
        status = HttpStatus.CREATED;
      } else {
        status = HttpStatus.BAD_REQUEST;
      }
    } catch (exception: unknown) {
      if (exception instanceof ApiException && exception.isDeviation) {
        // D47 (400) and D46 (409) — deliberate v2 refusals, raised before any storage call.
        // v1's blanket `except Exception` would launder them into a 500 and log them as
        // failures; they are neither. See `ApiException.deviation`.
        throw exception;
      }
      this.logger.error(`Exception saving file: ${describeException(exception)}`);
      if (isNonAsciiBoundaryFailure(request)) {
        // Plan §5 D22 decides this case for every multipart endpoint in Phases 4–8, this one
        // included: DRF's 400 parse error. v1 answers 500 here — flagged, see
        // `isNonAsciiBoundaryFailure`.
        throw exception;
      }
      if (isMultipartInitFailure(request)) {
        throw new Error(
          `multipart parse failed before the stream was read: ${describeException(exception)}`,
          { cause: exception },
        );
      }
      throw ApiException.empty(HttpStatus.INTERNAL_SERVER_ERROR);
    }
    throw ApiException.empty(status);
  }

  /**
   * `FileView.get`.
   *
   * ```python
   * type = int(request.query_params.get('type', -1))
   * files = file_service.get_files(type)
   * return Response(files, status = status.HTTP_200_OK)
   * ```
   *
   * ⚠️ **`int()` is outside any `try`** — `?type=`, `?type`, `?type=abc` and `?type=1.0` are
   * **uncaught 500s** (no `Allow`, no `Accept` in `Vary`), measured. {@link pythonInt} carries
   * the axes it was validated on: `?type=٠` and `?type=0_0` are type 0, `?type=%201%20` is 1.
   *
   * ⚠️ `-1` is "all", and so is `-01`. A repeated `?type=0&type=1` is the **last** value.
   */
  @Get()
  async list(@Query('type') typeRaw?: string | string[]): Promise<FileDto[]> {
    const raw = lastQueryValue(typeRaw);
    const type = raw === undefined ? -1 : pythonInt(raw);
    return this.files.getFiles(type);
  }

  /** See `LoanController.methodNotAllowed` — the route exists so the guard can run. */
  @DrfNoRequestData()
  @All()
  methodNotAllowed(@Req() request: Request): never {
    throw DrfException.methodNotAllowed(request.method, 'GET, POST, HEAD, OPTIONS');
  }
}

/** `str(exception)` for the log line; the message never reaches a response. */
function describeException(exception: unknown): string {
  return exception instanceof Error ? exception.message : String(exception);
}
