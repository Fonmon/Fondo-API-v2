import { encodePythonJsonString, pythonJsonDumps } from './python-json-dumps';

/**
 * Every `expected` string below is a **capture**, not a transcription: it was produced by
 * running `json.dumps(<input>)` on `python:3.9-slim` (CPython 3.9, the interpreter v1 runs)
 * and copying the result. The capture script lived at
 * `scratchpad/dumps.py` during Phase 2 development; the cases it covered are reproduced
 * here one-for-one so a future change can be re-validated the same way.
 */
describe('pythonJsonDumps — CPython json.dumps with default options', () => {
  describe('captured from CPython 3.9', () => {
    it.each([
      ['empty dict', {}, '{}'],
      ['empty list', [], '[]'],
      ['a flat dict uses ", " and ": " separators', { a: 1, b: 'x' }, '{"a": 1, "b": "x"}'],
      ['top-level array', [1, 'a', null], '[1, "a", null]'],
      ['nested empties', { a: {}, b: [] }, '{"a": {}, "b": []}'],
      ['booleans and None', { t: true, f: false, n: null }, '{"t": true, "f": false, "n": null}'],
      [
        'numbers',
        { i: 10, neg: -3, big: 12345678901234567890n, f: 1.5, f2: 0.1 },
        '{"i": 10, "neg": -3, "big": 12345678901234567890, "f": 1.5, "f2": 0.1}',
      ],
      [
        'ensure_ascii escapes the accents in every Spanish notification body',
        { message: 'Hoy está cumpliendo años Foo Name' },
        '{"message": "Hoy est\\u00e1 cumpliendo a\\u00f1os Foo Name"}',
      ],
      [
        'the loan payment-reminder message',
        { body: 'Recuerde que la fecha límite de pago para el crédito 1, es el: 26 sept. 2021' },
        '{"body": "Recuerde que la fecha l\\u00edmite de pago para el cr\\u00e9dito 1, es el: 26 sept. 2021"}',
      ],
      [
        'escapes, including DEL which JSON.stringify leaves literal',
        {
          s: 'quote " backslash \\ slash / newline \n tab \t cr \r bs \b ff \f ctrl \u0001 del \u007f',
        },
        '{"s": "quote \\" backslash \\\\ slash / newline \\n tab \\t cr \\r bs \\b ff \\f ctrl \\u0001 del \\u007f"}',
      ],
      [
        'astral characters become a surrogate pair',
        { emoji: '\u{1F600} café' },
        '{"emoji": "\\ud83d\\ude00 caf\\u00e9"}',
      ],
      ['non-ASCII keys are escaped too', { niño: 'año' }, '{"ni\\u00f1o": "a\\u00f1o"}'],
      ['control characters in keys', { 'a\tb': 'c' }, '{"a\\tb": "c"}'],
    ])('%s', (_name, input, expected) => {
      expect(pythonJsonDumps(input as never)).toBe(expected);
    });
  });

  describe('the actual SQS message body shape', () => {
    /**
     * This is the payload `NotificationService.send_notification` builds and
     * `celery/tasks.py` dumps. Captured from CPython 3.9 against the same object.
     */
    it('matches json.dumps byte for byte', () => {
      const content = {
        subscriptions: [
          {
            keys: { p256dh: 'A-B_c', auth: 'x' },
            endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
            expirationTime: null,
          },
        ],
        message: { body: 'Ha sido creada una nueva solicitud de crédito', target: '/loan/1' },
      };

      expect(pythonJsonDumps(content)).toBe(
        '{"subscriptions": [{"keys": {"p256dh": "A-B_c", "auth": "x"}, "endpoint": ' +
          '"https://fcm.googleapis.com/fcm/send/abc", "expirationTime": null}], "message": ' +
          '{"body": "Ha sido creada una nueva solicitud de cr\\u00e9dito", "target": "/loan/1"}}',
      );
    });

    it('differs from JSON.stringify — which is the whole point of this module', () => {
      const content = { message: { body: 'crédito', target: '/loan/1' } };
      expect(JSON.stringify(content)).not.toBe(pythonJsonDumps(content));
      expect(JSON.stringify(content)).toBe('{"message":{"body":"crédito","target":"/loan/1"}}');
    });

    it('preserves key order, so hstore ordering survives into the wire format', () => {
      // Postgres returns hstore keys ordered by (length, bytes): keys, endpoint, expirationTime.
      const fromHstore = { keys: {}, endpoint: 'e', expirationTime: null };
      expect(pythonJsonDumps(fromHstore)).toBe(
        '{"keys": {}, "endpoint": "e", "expirationTime": null}',
      );
      // A different insertion order produces different bytes; nothing sorts it for us.
      const reordered = { endpoint: 'e', keys: {}, expirationTime: null };
      expect(pythonJsonDumps(reordered)).toBe(
        '{"endpoint": "e", "keys": {}, "expirationTime": null}',
      );
    });
  });

  describe('allow_nan=True (CPython default) rather than JSON.stringify null-ing', () => {
    it.each([
      [Number.NaN, 'NaN'],
      [Number.POSITIVE_INFINITY, 'Infinity'],
      [Number.NEGATIVE_INFINITY, '-Infinity'],
    ])('%p -> %s', (input, expected) => {
      expect(pythonJsonDumps(input)).toBe(expected);
    });
  });

  describe('rejects what CPython rejects, rather than silently emitting null', () => {
    it('throws on undefined', () => {
      expect(() => pythonJsonDumps({ a: undefined } as never)).toThrow(TypeError);
    });

    it('throws on a Date', () => {
      expect(() => pythonJsonDumps({ at: new Date() } as never)).toThrow(
        /Object of type Date is not JSON serializable/,
      );
    });

    it('throws on a Map', () => {
      expect(() => pythonJsonDumps({ m: new Map() } as never)).toThrow(
        /Object of type Map is not JSON serializable/,
      );
    });

    it('throws on a circular structure', () => {
      const node: Record<string, unknown> = {};
      node.self = node;
      expect(() => pythonJsonDumps(node as never)).toThrow(/Circular reference detected/);
    });

    it('accepts a null-prototype object — that is still a plain mapping', () => {
      const bare = Object.create(null) as Record<string, string>;
      bare.a = 'b';
      expect(pythonJsonDumps(bare)).toBe('{"a": "b"}');
    });
  });

  describe('encodePythonJsonString', () => {
    it('is the ensure_ascii encoder, usable on its own', () => {
      expect(encodePythonJsonString('crédito')).toBe('"cr\\u00e9dito"');
    });

    it('leaves printable ASCII alone', () => {
      const printable = ' !#$%&()*+,-./0123456789:;<=>?@AZ[]^_`az{|}~';
      expect(encodePythonJsonString(printable)).toBe(`"${printable}"`);
    });
  });
});
