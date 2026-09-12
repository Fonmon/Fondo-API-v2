import { generateKeyPairSync } from 'node:crypto';
import { Storage, type Bucket } from '@google-cloud/storage';
import type { AppConfigService } from '../config/app-config.service';
import {
  FILE_STORAGE,
  GcsFileStorage,
  UnavailableFileStorage,
  assertEncodableObjectName,
  fileStorageProvider,
  type FileStorage,
} from './file-storage';

/**
 * The `@google-cloud/storage` adapter, **offline**.
 *
 * ⚠️ No request leaves this process: every network-bound SDK method is replaced with a spy
 * before it is called, and signing is local RSA. The key is generated per run, in memory,
 * for a service-account address that does not exist — it authorises nothing and is never
 * written anywhere (plan §7: no GCS credentials, ever).
 */
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

/** 2030-01-01T00:00:00.999Z — in the future (the SDK refuses a past expiry), and at `.999`. */
const CLOCK_AT_999_MS = 1893456000999;

interface OfflineStorage {
  storage: Storage;
  bucket: Bucket;
  bucketSpy: jest.SpyInstance;
  getMetadata: jest.SpyInstance;
}

function offlineStorage(): OfflineStorage {
  const storage = new Storage({
    projectId: 'fondo-parity-throwaway',
    credentials: {
      client_email: 'throwaway@fondo-parity-throwaway.iam.gserviceaccount.com',
      private_key: privateKey,
    },
  });
  const bucket = storage.bucket('fonmon');
  const getMetadata = jest.spyOn(bucket, 'getMetadata').mockResolvedValue([{}] as never);
  const bucketSpy = jest.spyOn(storage, 'bucket').mockReturnValue(bucket);
  return { storage, bucket, bucketSpy, getMetadata };
}

describe('GcsFileStorage (offline)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('getBucket is get_bucket: a metadata read before any blob is handed out', async () => {
    const { storage, bucketSpy, getMetadata } = offlineStorage();
    await new GcsFileStorage(storage).getBucket('fonmon');
    expect(bucketSpy).toHaveBeenCalledWith('fonmon');
    expect(getMetadata).toHaveBeenCalledTimes(1);
  });

  it('getBucket rejects when the bucket read fails (v1: get_bucket raises)', async () => {
    const { storage, getMetadata } = offlineStorage();
    getMetadata.mockRejectedValue(new Error('404 bucket'));
    await expect(new GcsFileStorage(storage).getBucket('fonmon')).rejects.toThrow('404 bucket');
  });

  it('signs a v4 GET for exactly 300 s, from ONE clock read (a clock at .999 cannot yield 299)', async () => {
    const { storage } = offlineStorage();
    // Each read advances 1 ms, so the first read is .999 and any second read is the next
    // second. A constant stub would let an adapter that reads the clock twice pass unseen.
    let reads = 0;
    const clock = (): number => CLOCK_AT_999_MS + reads++;
    const bucket = await new GcsFileStorage(storage, clock).getBucket('fonmon');
    const url = new URL(
      await bucket
        .blob('proceeding/acta número 1')
        .generateSignedUrl({ version: 'v4', expirationSeconds: 300, method: 'GET' }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://storage.googleapis.com/fonmon/proceeding/acta%20n%C3%BAmero%201',
    );
    expect(url.searchParams.get('X-Goog-Algorithm')).toBe('GOOG4-RSA-SHA256');
    expect(url.searchParams.get('X-Goog-Date')).toBe('20300101T000000Z');
    expect(url.searchParams.get('X-Goog-Expires')).toBe('300');
    expect(url.searchParams.get('X-Goog-SignedHeaders')).toBe('host');
    expect(url.searchParams.get('X-Goog-Credential')).toBe(
      'throwaway@fondo-parity-throwaway.iam.gserviceaccount.com/20300101/auto/storage/goog4_request',
    );
    // Parameter order is the canonical one v1's library emits (measured byte-identical, 8/8).
    expect([...url.searchParams.keys()]).toEqual([
      'X-Goog-Algorithm',
      'X-Goog-Credential',
      'X-Goog-Date',
      'X-Goog-Expires',
      'X-Goog-SignedHeaders',
      'X-Goog-Signature',
    ]);
  });

  it('exists() delegates to the SDK and returns its boolean', async () => {
    const { storage, bucket } = offlineStorage();
    const file = bucket.file('proceeding/x');
    jest.spyOn(bucket, 'file').mockReturnValue(file);
    jest.spyOn(file, 'exists').mockResolvedValue([true] as never);
    const blob = (await new GcsFileStorage(storage).getBucket('fonmon')).blob('proceeding/x');
    await expect(blob.exists()).resolves.toBe(true);
  });

  it.each([
    ['a content type', 'application/pdf', { contentType: 'application/pdf' }],
    ['an empty content type (registered residual: the SDK treats it as unset)', '', {}],
  ])('uploadFromFile with %s', async (_label, contentType, options) => {
    const { storage, bucket } = offlineStorage();
    const file = bucket.file('proceeding/x');
    jest.spyOn(bucket, 'file').mockReturnValue(file);
    const save = jest.spyOn(file, 'save').mockResolvedValue(undefined as never);
    const blob = (await new GcsFileStorage(storage).getBucket('fonmon')).blob('proceeding/x');
    await blob.uploadFromFile(Buffer.from('PDF'), contentType);
    expect(save).toHaveBeenCalledWith(Buffer.from('PDF'), options);
  });

  it('refuses a lone surrogate before the SDK sees the name (v1: UnicodeEncodeError in quote())', async () => {
    const { storage, bucket } = offlineStorage();
    const file = jest.spyOn(bucket, 'file');
    const handle = await new GcsFileStorage(storage).getBucket('fonmon');
    expect(() => handle.blob('proceeding/\ud800')).toThrow('surrogates not allowed');
    expect(file).not.toHaveBeenCalled();
  });

  it('assertEncodableObjectName accepts a well-formed astral pair', () => {
    expect(() => assertEncodableObjectName('proceeding/😀')).not.toThrow();
    expect(() => assertEncodableObjectName('proceeding/\udc00')).toThrow();
  });
});

describe('fileStorageProvider — v1’s ENVIRONMENT branch as an injection', () => {
  const build = (environment: string): FileStorage =>
    (fileStorageProvider as { useFactory: (config: AppConfigService) => FileStorage }).useFactory({
      environment,
    } as AppConfigService);

  it('binds FILE_STORAGE', () => {
    expect((fileStorageProvider as { provide: symbol }).provide).toBe(FILE_STORAGE);
  });

  it('ENVIRONMENT=test gets a store that refuses every call, never an anonymous client', async () => {
    const storage = build('test');
    expect(storage).toBeInstanceOf(UnavailableFileStorage);
    await expect(storage.getBucket('fonmon')).rejects.toThrow(
      'not available when ENVIRONMENT=test',
    );
  });

  it.each(['production', 'development'])('ENVIRONMENT=%s gets the GCS adapter', (environment) => {
    expect(build(environment)).toBeInstanceOf(GcsFileStorage);
  });
});
