import { All, Controller, Get, HttpStatus, Param, Req } from '@nestjs/common';
import type { Request } from 'express';
import { V1View } from '../auth/decorators/v1-view.decorator';
import { ApiException } from '../common/http/api.exception';
import { parseDjangoIntPathId } from '../common/http/django-int-path-id';
import { DrfNoRequestData } from '../common/http/drf-parser.interceptor';
import { DrfException } from '../common/http/drf.exception';
import { FileService } from './file.service';

/**
 * `fondo_api/views/file.py:FileDetailView`, mounted by
 * `url(r'^api/file/(?P<id>[0-9]+)$', …, name='view_file_detail')` — ⚠️ **no trailing slash**,
 * so `/api/file/5/` is a resolver 404.
 *
 * `list_permissions['FileDetailView']` is `GET 3`.
 */
@V1View('FileDetailView')
@Controller('api/file')
export class FileDetailController {
  constructor(private readonly files: FileService) {}

  /**
   * `FileDetailView.get`.
   *
   * ```python
   * url = file_service.get_signed_url(int(id))
   * if url is not None:
   *     return Response(url, status=status.HTTP_200_OK)
   * return Response(status=status.HTTP_404_NOT_FOUND)
   * ```
   *
   * `{"url": "<v4 signed GET, 300 s>"}`, or a bodiless 404. `/api/file/01` is id 1 (measured).
   * A storage failure is an **uncaught** 500 — nothing catches it in v1 either.
   */
  @Get(':id')
  async read(@Param('id') rawId: string): Promise<{ url: string }> {
    const url = await this.files.getSignedUrl(parseDjangoIntPathId(rawId));
    if (url === null) {
      throw ApiException.empty(HttpStatus.NOT_FOUND);
    }
    return url;
  }

  /** See `LoanController.methodNotAllowed` — the route exists so the guard can run. */
  @DrfNoRequestData()
  @All(':id')
  methodNotAllowed(@Req() request: Request): never {
    throw DrfException.methodNotAllowed(request.method, 'GET, HEAD, OPTIONS');
  }
}
