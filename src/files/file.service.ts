import { Inject, Injectable } from '@nestjs/common';
import type { DrfRequestDataEntry } from '../common/http/drf-request-data';
import { PythonAttributeError, PythonTypeError, toDjangoInt } from '../common/utils/python-obj';
import { pythonLower } from '../common/utils/python-lower';
import { nowInstant } from '../common/utils/timezone.util';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  FILE_ROW_SELECT,
  fileTypeDisplay,
  serializeFile,
  type FileDto,
} from './dto/file.serializers';
import { FILE_STORAGE, type FileStorage } from './file-storage';

/** `request.data['type']`, `['name']`, `['file']`, each resolved from its own source. */
export interface FileUploadData {
  readonly type: DrfRequestDataEntry;
  readonly name: DrfRequestDataEntry;
  readonly file: DrfRequestDataEntry;
}

/** v1's `blob.generate_signed_url(expiration=datetime.timedelta(minutes=5))`. */
export const SIGNED_URL_EXPIRATION_SECONDS = 5 * 60;

const INT4_MIN = -2147483648n;
const INT4_MAX = 2147483647n;

/**
 * `fondo_api/services/file.py:FileService`.
 *
 * No `transaction.atomic()` anywhere in v1's module, and none here: the one write that could
 * be paired with another — the object upload and the row — spans two systems that cannot
 * share a transaction, and v1's ordering (upload first, row second) is what decides which
 * partial state a failure leaves. See {@link saveFile}.
 */
@Injectable()
export class FileService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    private readonly config: AppConfigService,
  ) {}

  /**
   * `save_file(obj)`, statement for statement:
   *
   * ```python
   * file = File(type = int(obj["type"]), display_name = obj["name"])        # 1
   * bucket = self.client.get_bucket("fonmon")                                # 2  read
   * blob = bucket.blob("{}/{}".format(file.get_type_display(),
   *                                   file.display_name.lower()))            # 3
   * blob_exists = blob.exists()                                              # 4  read
   * blob.upload_from_file(obj["file"], content_type=obj["file"].content_type)  # 5  WRITE
   * if not blob_exists:
   *     file.save()                                                          # 6  WRITE
   * ```
   *
   * Every statement can raise, and the caller turns any exception into a 500. What a failure
   * leaves behind is therefore fixed by the order, all of it measured on the pinned v1:
   *
   * | fails at | example | object | row |
   * |---|---|---|---|
   * | 1 | `type=abc`, `type` sent as a file part | — | — |
   * | 2 | bucket unreachable | — | — |
   * | 3 | `name` sent as a file part; a JSON `name` that is not a string | — | — |
   * | 4 | `exists()` errors | — | — |
   * | 5 | `file` sent as a plain field (`.content_type`); the upload errors | — | — |
   * | 6 | ⚠️ the name exists under the **other** type; the row exists but the object did not; `type` beyond int4 | **written** | — |
   *
   * ⚠️ **Step 5 always runs**, whether or not the object existed: a second upload under the
   * same lowered path **overwrites** the object and writes no row, so the list keeps showing
   * the first upload's `display_name` over the second upload's bytes.
   *
   * ⚠️ **Row 6 is a partial write, and it is self-perpetuating.** After a cross-type
   * duplicate 500s, the object exists at the new path; a retry therefore finds it, overwrites
   * it, skips the row and answers **201** — for a file no list will ever show. Ported, not
   * fixed; registered in `docs/phase-8-deviations.md`.
   */
  async saveFile(obj: FileUploadData): Promise<void> {
    const type = pythonIntOf(obj.type, 'type'); // 1
    const bucket = await this.storage.getBucket(this.config.gcsBucket); // 2
    const displayName = lowerableName(obj.name);
    const blob = bucket.blob(`${fileTypeDisplay(type)}/${pythonLower(displayName)}`); // 3
    const blobExists = await blob.exists(); // 4
    const upload = uploadedFileOf(obj.file);
    await blob.uploadFromFile(upload.buffer, upload.mimetype); // 5
    if (!blobExists) {
      // 6 — `created_at` is `auto_now_add`, application-set: the column has no default.
      await this.prisma.file.create({
        data: {
          type: int4Column(type),
          display_name: displayName,
          created_at: nowInstant(),
        },
        select: { id: true },
      });
    }
  }

  /**
   * `get_files(type)`.
   *
   * ```python
   * if type == -1: files = File.objects.all().order_by('created_at')
   * else:          files = File.objects.filter(type = type).order_by('created_at')
   * ```
   *
   * ⚠️ **Not paginated** — a bare JSON list, unlike every other list endpoint in v1.
   *
   * ⚠️ **`id` is a v2 tie-break.** v1 orders by `created_at` alone, so rows with equal
   * `created_at` come back in whatever order PostgreSQL chooses; `fondodev` has one such pair
   * (ids 36 and 37, measured 2026-09-12). v2 adds `id` so the order is stable. Registered;
   * parity is not claimed for the relative order of tied rows.
   *
   * A `type` outside int4 matches nothing in v1 (PostgreSQL compares against the larger
   * literal; measured: `?type=2147483648` and `?type=99999999999999999999` are `[]`). Prisma
   * cannot express the comparison, so the query is skipped and the same empty list returned.
   */
  async getFiles(type: number): Promise<FileDto[]> {
    if (type !== -1 && (BigInt(type) < INT4_MIN || BigInt(type) > INT4_MAX)) {
      return [];
    }
    const rows = await this.prisma.file.findMany({
      where: type === -1 ? undefined : { type },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      select: FILE_ROW_SELECT,
    });
    return rows.map(serializeFile);
  }

  /**
   * `get_signed_url(id)`.
   *
   * ```python
   * try:
   *     file = File.objects.get(id = id)
   *     bucket = self.client.get_bucket("fonmon")
   *     blob = bucket.blob("{}/{}".format(file.get_type_display(), file.display_name.lower()))
   *     url = blob.generate_signed_url(version="v4", expiration=datetime.timedelta(minutes=5), method="GET")
   *     return {"url": url}
   * except File.DoesNotExist:
   *     return None
   * ```
   *
   * Only `DoesNotExist` is caught: a storage failure propagates and the view does not catch
   * it either, so it is an **uncaught** 500 (measured). The URL is signed whether or not the
   * object exists — signing is local and asks the store nothing.
   *
   * @returns `null` for v1's `None` (the view's 404).
   */
  async getSignedUrl(id: number): Promise<{ url: string } | null> {
    const file = await this.prisma.file.findUnique({ where: { id }, select: FILE_ROW_SELECT });
    if (file === null) {
      return null;
    }
    const bucket = await this.storage.getBucket(this.config.gcsBucket);
    const blob = bucket.blob(`${fileTypeDisplay(file.type)}/${pythonLower(file.display_name)}`);
    const url = await blob.generateSignedUrl({
      version: 'v4',
      expirationSeconds: SIGNED_URL_EXPIRATION_SECONDS,
      method: 'GET',
    });
    return { url };
  }
}

/** `int(obj[key])`. A file part is `int(InMemoryUploadedFile)` → `TypeError`. */
function pythonIntOf(entry: DrfRequestDataEntry, key: string): bigint {
  if (entry.source === 'file') {
    throw new PythonTypeError(
      "int() argument must be a string, a bytes-like object or a number, not 'InMemoryUploadedFile'",
    );
  }
  return toDjangoInt(entry.value, key);
}

/** `file.display_name.lower()` — anything but a `str` has no `.lower`. */
function lowerableName(entry: DrfRequestDataEntry): string {
  if (entry.source === 'file') {
    throw new PythonAttributeError('InMemoryUploadedFile', 'lower');
  }
  if (typeof entry.value !== 'string') {
    throw new PythonAttributeError(pythonTypeName(entry.value), 'lower');
  }
  return entry.value;
}

/** `obj["file"].content_type` — a field value has no `.content_type`. */
function uploadedFileOf(entry: DrfRequestDataEntry): { buffer: Buffer; mimetype: string } {
  if (entry.source === 'field') {
    throw new PythonAttributeError(pythonTypeName(entry.value), 'content_type');
  }
  return entry.file;
}

/**
 * The `integer` column. v1 hands any Python int to `INSERT` and PostgreSQL raises
 * `integer out of range` — **after** the upload, so the object stays (measured).
 */
function int4Column(type: bigint): number {
  if (type < INT4_MIN || type > INT4_MAX) {
    throw new Error('integer out of range');
  }
  return Number(type);
}

function pythonTypeName(value: unknown): string {
  if (value === null || value === undefined) {
    return 'NoneType';
  }
  if (typeof value === 'string') {
    return 'str';
  }
  if (typeof value === 'boolean') {
    return 'bool';
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return typeof value === 'number' && !Number.isInteger(value) ? 'float' : 'int';
  }
  return Array.isArray(value) ? 'list' : 'dict';
}
