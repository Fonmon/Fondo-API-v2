import type {
  FileStorage,
  FileStorageBlob,
  FileStorageBucket,
  SignedUrlOptions,
} from '../../src/files/file-storage';

/** One storage call, in the shape `~/.fondo-parity-harness/p8/oracle.py` records v1's. */
export type StorageCall =
  | readonly ['get_bucket', string]
  | readonly ['blob', string]
  | readonly ['exists', string]
  | readonly ['upload', string, string]
  | readonly ['sign', string, string, number, string];

export type StorageFailure = 'get_bucket' | 'exists' | 'upload' | 'sign';

/**
 * An in-memory {@link FileStorage} that records every call — the v2 twin of the fake the v1
 * oracle patched over `storage.Client.get_bucket`. Because both record the same tuples, an
 * e2e cell can compare v2's call sequence to v1's measured one directly.
 *
 * It never touches the network and holds no credentials. Plan §7: no test may reach GCS.
 */
export class RecordingFileStorage implements FileStorage {
  readonly calls: StorageCall[] = [];
  readonly objects = new Map<string, { readonly data: string; readonly contentType: string }>();
  readonly failures = new Set<StorageFailure>();
  /** What `generate_signed_url` returns — v1's `test_get_url` sets `"This is a URL"`. */
  signedUrl: (path: string) => string = (path) => `signed://${path}`;

  /**
   * Awaited by `uploadFromFile` **after** the call is recorded and before the object is stored.
   * Lets a test hold two uploads open at once — the D46 check-then-act window.
   */
  beforeUpload: (path: string) => Promise<void> = () => Promise.resolve();

  reset(): void {
    this.calls.length = 0;
    this.objects.clear();
    this.failures.clear();
    this.signedUrl = (path) => `signed://${path}`;
    this.beforeUpload = () => Promise.resolve();
  }

  getBucket(name: string): Promise<FileStorageBucket> {
    this.calls.push(['get_bucket', name]);
    if (this.failures.has('get_bucket')) {
      return Promise.reject(new Error('bucket failed'));
    }
    return Promise.resolve({ blob: (path: string) => this.blob(path) });
  }

  private blob(path: string): FileStorageBlob {
    this.calls.push(['blob', path]);
    return {
      exists: () => {
        this.calls.push(['exists', path]);
        if (this.failures.has('exists')) {
          return Promise.reject(new Error('exists failed'));
        }
        return Promise.resolve(this.objects.has(path));
      },
      uploadFromFile: async (data: Buffer, contentType: string) => {
        this.calls.push(['upload', path, contentType]);
        await this.beforeUpload(path);
        if (this.failures.has('upload')) {
          throw new Error('error uploading file');
        }
        this.objects.set(path, { data: data.toString('utf8'), contentType });
      },
      generateSignedUrl: (options: SignedUrlOptions) => {
        this.calls.push(['sign', path, options.version, options.expirationSeconds, options.method]);
        if (this.failures.has('sign')) {
          return Promise.reject(new Error('sign failed'));
        }
        return Promise.resolve(this.signedUrl(path));
      },
    };
  }
}
