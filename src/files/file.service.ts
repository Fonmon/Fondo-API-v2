import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ApiException } from '../common/http/api.exception';
import type { DrfRequestDataEntry } from '../common/http/drf-request-data';
import { PythonAttributeError, toDjangoInt } from '../common/utils/python-obj';
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
   * v2 inserts two refusals between the presence check and statement 2 — plan §5 **D47**
   * (400, in place of statement 1's `int()`) then **D46** (409). Both are raised before any
   * storage call and flagged `isDeviation`, so the view's blanket 500 does not swallow them.
   *
   * Every other statement can raise, and the caller turns any exception into a 500. What a
   * failure leaves behind is fixed by the order, measured on the pinned v1:
   *
   * | fails at | example | object | row |
   * |---|---|---|---|
   * | 1 (D47) | `type=abc`, `type=5`, `type` beyond int4, `type` sent as a file part → **400** in v2 | — | — |
   * | D46 | the exact name exists under the **other** type → **409** in v2 | — | — |
   * | 2 | bucket unreachable | — | — |
   * | 3 | `name` sent as a file part; a JSON `name` that is not a string | — | — |
   * | 4 | `exists()` errors | — | — |
   * | 5 | `file` sent as a plain field (`.content_type`); the upload errors | — | — |
   * | 6 | ⚠️ the row exists under the same type but the object did not (Q41, kept); a name containing U+0000; the losing side of two **concurrent** cross-type uploads (D46's window) | **written** | — |
   *
   * ⚠️ **Step 5 always runs**, whether or not the object existed: a second upload under the
   * same lowered path **overwrites** the object and writes no row, so the list keeps showing
   * the first upload's `display_name` over the second upload's bytes (Q41, kept).
   */
  async saveFile(obj: FileUploadData): Promise<void> {
    const type = knownFileType(obj.type); // 1 — D47
    await this.refuseNameUnderOtherType(obj.name, type); // D46
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
          type,
          display_name: displayName,
          created_at: nowInstant(),
        },
        select: { id: true },
      });
    }
  }

  /**
   * **D46** (plan §5, operator Q40) — a v2 control v1 does not have. Runs after D47 and
   * **before any storage call**.
   *
   * Refuses with **409** `{"message": "A file with this name already exists with a different
   * type"}` when a row with **exactly** this `display_name` exists and its `type` differs.
   * "Exactly" is PostgreSQL `=` on the `text` column — the comparison the
   * `fondo_api_file_display_name_key` unique index itself uses, so the refusal fires on the
   * names whose insert would violate that constraint. `test/file.e2e-spec.ts` pins a
   * case variant (`ACTA NÚMERO 1` over `Acta número 1`, other type) as **not** refused.
   *
   * Not refused, and left to v1's statements below:
   * - the same name under the **same** type (v1's overwrite, and the row-without-object 500 —
   *   Q41, kept, no log line);
   * - a name differing only in case under the other type (v1 writes a new row).
   *
   * ⚠️ **A name no row can hold is not queried.** A `name` that is a file part or a non-string
   * JSON value (measurement 2 / P8-F7), or a string containing U+0000 (PostgreSQL `text`
   * cannot store it), cannot equal any `display_name`, so the predicate is false and v1's own
   * failure follows unchanged — a 500 after `get_bucket` for the first two, and for U+0000 the
   * upload followed by the failed insert. Querying anyway would either read a file as a
   * scalar (D23) or turn v1's measured sequence into a query error with no storage calls.
   *
   * ⚠️ **Check-then-act.** Two concurrent uploads of one new name under different types can
   * both pass this check before either inserts; the loser then fails on the unique index
   * **after** its upload, as v1 does. Measured and registered in `docs/phase-8-deviations.md`.
   *
   * @throws ApiException 409, flagged `isDeviation` so `FileController` does not launder it
   *   into v1's blanket 500.
   */
  private async refuseNameUnderOtherType(name: DrfRequestDataEntry, type: 0 | 1): Promise<void> {
    if (name.source === 'file' || typeof name.value !== 'string' || name.value.includes('\0')) {
      return;
    }
    const existing = await this.prisma.file.findUnique({
      where: { display_name: name.value },
      select: { type: true },
    });
    if (existing !== null && existing.type !== type) {
      throw ApiException.deviation(HttpStatus.CONFLICT, D46_MESSAGE);
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

/** D46's body. */
export const D46_MESSAGE = 'A file with this name already exists with a different type';
/** D47's body, modelled on `SavingAccountView.get`'s `State must be between 0 and 1`. */
export const D47_MESSAGE = 'Type must be 0 or 1';

/**
 * **D47** (plan §5, operator Q42) in place of v1's `int(obj["type"])` — the first statement of
 * `save_file`, so it runs after the view's presence check and before D46 and any storage call.
 *
 * The predicate is **"v1's own `int(obj['type'])` returns 0 or 1"**; everything else is a
 * **400** `{"message": "Type must be 0 or 1"}`. For a string that is {@link toDjangoInt}'s
 * string branch, i.e. `parsePythonIntLiteral`, the grammar {@link pythonInt} uses. Accepted,
 * measured on the pinned v1 (`~/.fondo-parity-harness/p8/oracle-d46-out.jsonl`, 2026-09-14)
 * and pinned by `file.service.spec.ts` / `test/file.e2e-spec.ts`:
 * `' 1 '`, `'１'` (fullwidth), `'\xa01'`, `'+0'`, `'-0'`, `'0_1'`. Refused: `'1_0'` (10),
 * `'＋1'` and `'\x1c1'` (not integers to `int()`), `'abc'`, `'1.0'`, `'-1'`, `' ٣ '`, and
 * anything past int4 — which v1 stored and then 500ed.
 *
 * What `int()` raises on is refused too, since it is not the integer 0 or 1: a `type` sent as
 * a **file part** (v1: `TypeError`, 500 before any storage call — measurement 2) and a JSON
 * `null` / list / object. ⚠️ A JSON `1.5` or `true` is `int()`-ed to 1 as in v1 and therefore
 * **passes**; a JSON body can never upload (P8-F7), so this changes no 201. Flagged as
 * underspecified in `docs/phase-8-deviations.md`.
 *
 * @throws ApiException 400, flagged `isDeviation`.
 */
function knownFileType(entry: DrfRequestDataEntry): 0 | 1 {
  let type: bigint | undefined;
  if (entry.source === 'field') {
    try {
      type = toDjangoInt(entry.value, 'type');
    } catch {
      type = undefined;
    }
  }
  if (type === 0n) {
    return 0;
  }
  if (type === 1n) {
    return 1;
  }
  throw ApiException.deviation(HttpStatus.BAD_REQUEST, D47_MESSAGE);
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
