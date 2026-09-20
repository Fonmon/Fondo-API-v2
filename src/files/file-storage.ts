import type { Provider } from '@nestjs/common';
import { Storage, type Bucket, type File as GcsFile } from '@google-cloud/storage';
import { AppConfigService } from '../config/app-config.service';

/**
 * The object store behind `FileService`, as an injected boundary — Phase 8, measurement 8.
 *
 * v1 picks its client in the service constructor (`services/file.py:13-16`):
 *
 * ```python
 * if settings.ENVIRONMENT == 'test':
 *     self.client = storage.Client.create_anonymous_client()
 * else:
 *     self.client = storage.Client()
 * ```
 *
 * v2 makes that choice a provider ({@link fileStorageProvider}). Only `test/file.e2e-spec.ts`
 * overrides {@link FILE_STORAGE} with a fake; every other suite runs with `ENVIRONMENT=test`
 * (set by `test/setup-env.ts`) and so gets {@link UnavailableFileStorage}. The interface mirrors the calls v1 makes, **in the order it
 * makes them**, so a fake can record the sequence and a cell can assert that a failure at step
 * *n* leaves steps *n+1…* unrun:
 *
 * | v1 | here |
 * |---|---|
 * | `client.get_bucket("fonmon")` — a `GET` on the bucket, raises if it is missing | {@link FileStorage.getBucket} |
 * | `bucket.blob(path)` — no I/O | {@link FileStorageBucket.blob} |
 * | `blob.exists()` | {@link FileStorageBlob.exists} |
 * | `blob.upload_from_file(f, content_type=f.content_type)` — overwrites | {@link FileStorageBlob.uploadFromFile} |
 * | `blob.generate_signed_url(version="v4", expiration=timedelta(minutes=5), method="GET")` | {@link FileStorageBlob.generateSignedUrl} |
 */
export const FILE_STORAGE = Symbol('FILE_STORAGE');

export interface FileStorage {
  getBucket(name: string): Promise<FileStorageBucket>;
}

export interface FileStorageBucket {
  blob(name: string): FileStorageBlob;
}

export interface FileStorageBlob {
  exists(): Promise<boolean>;
  /** @param contentType the part's `Content-Type` main value, `''` when the part had none. */
  uploadFromFile(data: Buffer, contentType: string): Promise<void>;
  generateSignedUrl(options: SignedUrlOptions): Promise<string>;
}

export interface SignedUrlOptions {
  readonly version: 'v4';
  readonly expirationSeconds: number;
  readonly method: 'GET';
}

/**
 * `google-cloud-storage` 1.38 behind {@link FileStorage}, using `@google-cloud/storage`.
 *
 * ## Signed URLs — measured byte-identical
 *
 * With one throwaway RSA key (generated locally, bound to no account) and one pinned instant,
 * the pinned Python library and this adapter's library produced **the same URL for 8 of 8
 * object names** on 2026-09-12 — including `!'()*`, non-ASCII, a tab, and the empty name
 * (`~/.fondo-parity-harness/p8/sign-{py,node}.jsonl`). That depends on one thing this adapter
 * must do itself: the signing instant and the expiry must come from **one** clock read. The
 * library floors both to seconds independently, so `expires: Date.now() + 300_000` read a
 * millisecond before the library's own `new Date()` yields `X-Goog-Expires=299` whenever the
 * two reads straddle a second. `file-storage.spec.ts` pins that with a clock at `.999`.
 *
 * ## Residuals, registered in `docs/phase-8-deviations.md`
 *
 *  * **Empty content type.** v1's `_get_content_type` tests `is None`, so a part with no
 *    `Content-Type` header uploads with `content_type=''`. `@google-cloud/storage` treats a
 *    falsy content type as unset and guesses one from the object name. No browser sends a file
 *    part without a `Content-Type`.
 *  * **Upload protocol.** v1 passes no `size`, so `google-resumable-media` uses a resumable
 *    session; the object written is the same either way.
 */
export class GcsFileStorage implements FileStorage {
  constructor(
    private readonly storage: Storage,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  async getBucket(name: string): Promise<FileStorageBucket> {
    const bucket = this.storage.bucket(name);
    // `get_bucket` is `Bucket.reload()`: a metadata GET that raises on a missing bucket.
    await bucket.getMetadata();
    return new GcsBucket(bucket, this.clock);
  }
}

class GcsBucket implements FileStorageBucket {
  constructor(
    private readonly bucket: Bucket,
    private readonly clock: () => number,
  ) {}

  /**
   * No I/O, as in v1 — but the SDK's `File` constructor runs `encodeURIComponent(name)` and
   * throws `URIError` on a lone surrogate, so the refusal is raised here, with v1's message,
   * rather than one call later where `quote()` raises it in v1. Nothing is sent either way.
   */
  blob(name: string): FileStorageBlob {
    assertEncodableObjectName(name);
    return new GcsBlob(this.bucket.file(name), this.clock);
  }
}

class GcsBlob implements FileStorageBlob {
  constructor(
    private readonly file: GcsFile,
    private readonly clock: () => number,
  ) {}

  async exists(): Promise<boolean> {
    const [exists] = await this.file.exists();
    return exists;
  }

  async uploadFromFile(data: Buffer, contentType: string): Promise<void> {
    await this.file.save(data, contentType === '' ? {} : { contentType });
  }

  async generateSignedUrl(options: SignedUrlOptions): Promise<string> {
    const now = this.clock();
    const [url] = await this.file.getSignedUrl({
      version: options.version,
      // `method="GET"` is the SDK's `'read'`; `SignedUrlOptions.method` admits nothing else.
      action: 'read',
      accessibleAt: new Date(now),
      expires: now + options.expirationSeconds * 1000,
    });
    return url;
  }
}

/**
 * Python builds the request path with `quote(name.encode('utf-8'))`, which raises
 * `UnicodeEncodeError` on a lone surrogate before any request is sent. JavaScript would
 * silently substitute U+FFFD and address a *different* object. Refuse instead.
 */
export function assertEncodableObjectName(name: string): void {
  if (/\p{Cs}/u.test(name)) {
    throw new Error(`'utf-8' codec can't encode object name: surrogates not allowed`);
  }
}

/**
 * v1's `ENVIRONMENT == 'test'` branch built an **anonymous** client — one that still makes
 * real, unauthenticated requests to Google. v2 binds a store that refuses every call instead,
 * so a test that forgets to install a fake fails loudly rather than reaching the network.
 * Registered in `docs/phase-8-deviations.md` (test environments only).
 */
export class UnavailableFileStorage implements FileStorage {
  getBucket(name: string): Promise<FileStorageBucket> {
    return Promise.reject(
      new Error(`file storage is not available when ENVIRONMENT=test (bucket ${name})`),
    );
  }
}

export const fileStorageProvider: Provider = {
  provide: FILE_STORAGE,
  inject: [AppConfigService],
  useFactory: (config: AppConfigService): FileStorage =>
    config.environment === 'test'
      ? new UnavailableFileStorage()
      : new GcsFileStorage(new Storage()),
};
