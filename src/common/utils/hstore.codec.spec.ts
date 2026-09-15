import {
  decodePushSubscription,
  decodeSchedulerPayload,
  encodeHstore,
  formatHstore,
  parseHstore,
  pythonRepr,
  pythonReprString,
  pythonStr,
  repairPythonReprToJson,
  toHstoreLiteral,
} from './hstore.codec';

/**
 * The two "real row" fixtures below are the text PostgreSQL returns for
 * `SELECT subscription::text` / `SELECT payload::text` on the shared dev database, with the
 * subscription taken from v1's own `tests/test_notification_views.py` fixture so nothing
 * private is committed. Expected Python encodings were produced by running Django's
 * `HStoreField.get_prep_value` logic under CPython.
 */
const V1_SUBSCRIPTION = {
  endpoint:
    'https://fcm.googleapis.com/fcm/send/eX6bP7wJrF4:APA91bG3MLpEG28xFOuYLQc-AB78XRywxVFOtGQpGwUQp5NWc-6GYzjvgSdCIiI4U_cFsS22Qi9QPpdI3hZ1OjyO8LcAoSfmhnK31IaXJc7OhnaauHzToLZt7HpP9bZO59yIP8i5FWs5',
  expirationTime: null,
  keys: {
    p256dh:
      'BHUdL9eM2s6BoDOIl0zz68ZsPqY9wLAQC8CttBykmgZC1SU3U7wV6tKcJ4wjkj1-T_0qrsOqjzBmTcxvhUPilA4',
    auth: '60-ComhtIqES-C7GmbrDVg',
  },
} as const;

const STORED_KEYS_REPR =
  "{'p256dh': 'BHUdL9eM2s6BoDOIl0zz68ZsPqY9wLAQC8CttBykmgZC1SU3U7wV6tKcJ4wjkj1-T_0qrsOqjzBmTcxvhUPilA4', 'auth': '60-ComhtIqES-C7GmbrDVg'}";

/** PostgreSQL emits hstore entries ordered by (key length, key bytes). */
const SUBSCRIPTION_ROW_TEXT =
  `"keys"=>"${STORED_KEYS_REPR}", ` +
  `"endpoint"=>"${V1_SUBSCRIPTION.endpoint}", "expirationTime"=>NULL`;

const PAYLOAD_ROW_TEXT =
  '"type"=>"payment_reminder", "target"=>"/loan/53", ' +
  '"message"=>"Recuerde que la fecha límite de pago para el crédito 53, es el: 9 sept. 2099", ' +
  '"owner_id"=>"53", "user_ids"=>"[5]"';

describe('parseHstore', () => {
  it('parses a real notificationsubscriptions row', () => {
    expect(parseHstore(SUBSCRIPTION_ROW_TEXT)).toEqual({
      keys: STORED_KEYS_REPR,
      endpoint: V1_SUBSCRIPTION.endpoint,
      expirationTime: null,
    });
  });

  it('parses a real schedulertask row', () => {
    expect(parseHstore(PAYLOAD_ROW_TEXT)).toEqual({
      type: 'payment_reminder',
      target: '/loan/53',
      message: 'Recuerde que la fecha límite de pago para el crédito 53, es el: 9 sept. 2099',
      owner_id: '53',
      user_ids: '[5]',
    });
  });

  it('preserves PostgreSQL key order, which is part of the SQS wire format', () => {
    expect(Object.keys(parseHstore(SUBSCRIPTION_ROW_TEXT))).toEqual([
      'keys',
      'endpoint',
      'expirationTime',
    ]);
    expect(Object.keys(parseHstore(PAYLOAD_ROW_TEXT))).toEqual([
      'type',
      'target',
      'message',
      'owner_id',
      'user_ids',
    ]);
  });

  it('maps NULL to null, distinct from the string "NULL"', () => {
    expect(parseHstore('"a"=>NULL, "b"=>"NULL"')).toEqual({ a: null, b: 'NULL' });
  });

  it('unescapes quotes and backslashes', () => {
    expect(parseHstore('"a"=>"say \\"hi\\"", "b"=>"back\\\\slash"')).toEqual({
      a: 'say "hi"',
      b: 'back\\slash',
    });
  });

  it('handles an empty hstore', () => {
    expect(parseHstore('')).toEqual({});
    expect(parseHstore('   ')).toEqual({});
  });

  it('accepts values containing "=>" and commas', () => {
    expect(parseHstore('"a"=>"x=>y, z"')).toEqual({ a: 'x=>y, z' });
  });

  it('rejects malformed input rather than guessing', () => {
    expect(() => parseHstore('"a"->"b"')).toThrow(SyntaxError);
    expect(() => parseHstore('"a"=>"unterminated')).toThrow(SyntaxError);
    expect(() => parseHstore('NULL=>"b"')).toThrow(SyntaxError);
  });

  /**
   * **Phase 9, step 6 — why Release A cannot be left running on the converted schema.**
   *
   * After the hstore -> jsonb migration, `SELECT payload::text` — which is what both raw-SQL
   * repositories issue — returns JSON text, not an hstore rendering. Measured on the migrated
   * clone `fondodev_p9_run`, 2026-09-15:
   *
   *     {"type": "birthdate", "target": "/", "message": "...", "owner_id": "1", "user_ids": [2, 4]}
   *
   * The write side already fails at the type level (`column "payload" is of type jsonb but
   * expression is of type hstore`), and this is the read side: it throws rather than decoding
   * something plausible. So the Release A -> jsonb combination is loud in both directions,
   * which is what makes the step-6 ordering in `docs/phase-9-design.md` §6 a short outage
   * rather than a silent corruption.
   */
  it('step 6: rejects the JSON text a converted jsonb column renders', () => {
    const afterConversion =
      '{"type": "birthdate", "target": "/", "message": "Hoy", "owner_id": "1", "user_ids": [2, 4]}';
    expect(() => parseHstore(afterConversion)).toThrow(SyntaxError);
  });
});

describe('formatHstore', () => {
  it('round-trips through parseHstore', () => {
    const map = {
      simple: 'value',
      quoted: 'say "hi"',
      slashed: 'back\\slash',
      empty: '',
      nothing: null,
      'weird key=>,': 'ok',
    };
    expect(parseHstore(formatHstore(map))).toEqual(map);
  });

  it('emits NULL unquoted and everything else quoted', () => {
    expect(formatHstore({ a: '1', b: null })).toBe('"a"=>"1", "b"=>NULL');
  });

  it('produces literal text PostgreSQL accepts for a real subscription', () => {
    expect(parseHstore(toHstoreLiteral({ ...V1_SUBSCRIPTION }))).toEqual(
      parseHstore(SUBSCRIPTION_ROW_TEXT),
    );
  });
});

describe('pythonReprString (CPython str.__repr__)', () => {
  it.each([
    ['abc', "'abc'"],
    ["it's", '"it\'s"'],
    ['say "hi"', '\'say "hi"\''],
    ['both \' and "', "'both \\' and \"'"],
    ['a\nb', "'a\\nb'"],
    ['a\tb', "'a\\tb'"],
    ['a\rb', "'a\\rb'"],
    ['back\\slash', "'back\\\\slash'"],
    ['\u0001', "'\\x01'"],
    ['ñ', "'ñ'"],
    ['', "''"],
  ])('pythonReprString(%j) === %j', (input, expected) => {
    expect(pythonReprString(input)).toBe(expected);
  });
});

describe('pythonRepr / pythonStr (Django HStoreField.get_prep_value coercion)', () => {
  it.each([
    [5, '5'],
    [-5, '-5'],
    [0, '0'],
    [true, 'True'],
    [false, 'False'],
    [null, 'None'],
    [[1, 2, 3], '[1, 2, 3]'],
    [[], '[]'],
    [[5], '[5]'],
    [{}, '{}'],
    [{ a: 1, b: null }, "{'a': 1, 'b': None}"],
  ])('pythonRepr(%j) === %j', (input, expected) => {
    expect(pythonRepr(input)).toBe(expected);
  });

  it('str() leaves a top-level string unquoted but repr() quotes it', () => {
    expect(pythonStr('abc')).toBe('abc');
    expect(pythonRepr('abc')).toBe("'abc'");
  });

  it('encodes a push subscription exactly the way Django wrote the live rows', () => {
    expect(encodeHstore({ ...V1_SUBSCRIPTION })).toEqual({
      endpoint: V1_SUBSCRIPTION.endpoint,
      expirationTime: null,
      keys: STORED_KEYS_REPR,
    });
  });

  it('encodes a scheduler payload exactly the way Django wrote the live rows', () => {
    expect(
      encodeHstore({
        type: 'payment_reminder',
        owner_id: 53,
        user_ids: [5],
        target: '/loan/53',
        message: 'Recuerde que la fecha límite de pago para el crédito 53, es el: 9 sept. 2099',
      }),
    ).toEqual({
      type: 'payment_reminder',
      owner_id: '53',
      user_ids: '[5]',
      target: '/loan/53',
      message: 'Recuerde que la fecha límite de pago para el crédito 53, es el: 9 sept. 2099',
    });
  });

  it('nests a dict as a Python repr, NOT as JSON', () => {
    // This single line is why the read path needs the ' -> " repair.
    expect(encodeHstore({ keys: { auth: 'x' } }).keys).toBe("{'auth': 'x'}");
    expect(encodeHstore({ keys: { auth: 'x' } }).keys).not.toBe('{"auth": "x"}');
  });
});

describe('repairPythonReprToJson', () => {
  it('replaces EVERY single quote, not just the first', () => {
    // Python's str.replace is global; JS String.replace with a string pattern is not.
    const repr = "{'p256dh': 'abc', 'auth': 'def'}";
    expect(repairPythonReprToJson(repr)).toBe('{"p256dh": "abc", "auth": "def"}');
    // The bug this helper prevents:
    expect(repr.replace("'", '"')).not.toBe(repairPythonReprToJson(repr));
  });

  it('produces parseable JSON for a real stored keys value', () => {
    const stored = parseHstore(SUBSCRIPTION_ROW_TEXT).keys as string;
    expect(JSON.parse(repairPythonReprToJson(stored))).toEqual(V1_SUBSCRIPTION.keys);
  });
});

describe('decodePushSubscription (NotificationService.send_notification)', () => {
  it('rebuilds the object the browser originally sent', () => {
    const decoded = decodePushSubscription(parseHstore(SUBSCRIPTION_ROW_TEXT));
    expect(decoded).toEqual({
      keys: V1_SUBSCRIPTION.keys,
      endpoint: V1_SUBSCRIPTION.endpoint,
      expirationTime: null,
    });
  });

  it('keeps expirationTime null and every other entry a string', () => {
    const decoded = decodePushSubscription(parseHstore(SUBSCRIPTION_ROW_TEXT));
    expect(decoded.expirationTime).toBeNull();
    expect(typeof decoded.endpoint).toBe('string');
    expect(typeof decoded.keys).toBe('object');
  });

  it('preserves key order so JSON.stringify matches v1 json.dumps byte for byte', () => {
    const decoded = decodePushSubscription(parseHstore(SUBSCRIPTION_ROW_TEXT));
    expect(Object.keys(decoded)).toEqual(['keys', 'endpoint', 'expirationTime']);
  });

  it('survives a full write -> store -> read round trip', () => {
    const literal = toHstoreLiteral({ ...V1_SUBSCRIPTION });
    expect(decodePushSubscription(parseHstore(literal))).toEqual({
      endpoint: V1_SUBSCRIPTION.endpoint,
      expirationTime: null,
      keys: V1_SUBSCRIPTION.keys,
    });
  });

  it('throws when the keys entry is SQL NULL rather than publishing a broken payload', () => {
    expect(() => decodePushSubscription({ endpoint: 'x', keys: null })).toThrow(TypeError);
  });

  // Condition C23 / finding S5: the *absent* case used to fail open — the loop simply never
  // visited a key that was not there, so the subscription decoded without `keys` and
  // `NotificationPublisher` published it. v1 raises `KeyError` and publishes nothing.
  it('C23: throws a KeyError when the keys entry is absent, not only when it is NULL', () => {
    expect(() => decodePushSubscription({ endpoint: 'x' })).toThrow("KeyError: 'keys'");
  });

  it('C23: an absent keys entry never yields a decoded object', () => {
    const attempt = (): unknown => decodePushSubscription({ endpoint: 'x', expirationTime: null });
    expect(attempt).toThrow("KeyError: 'keys'");
  });
});

describe('decodeSchedulerPayload (NotificationExecuter.run)', () => {
  it('json.loads-es only user_ids', () => {
    const decoded = decodeSchedulerPayload(parseHstore(PAYLOAD_ROW_TEXT));
    expect(decoded.user_ids).toEqual([5]);
    expect(decoded.owner_id).toBe('53');
    expect(decoded.type).toBe('payment_reminder');
    expect(decoded.target).toBe('/loan/53');
  });

  it('handles a multi-user id list', () => {
    expect(decodeSchedulerPayload({ user_ids: '[1, 2, 3]' }).user_ids).toEqual([1, 2, 3]);
    expect(decodeSchedulerPayload({ user_ids: '[]' }).user_ids).toEqual([]);
  });

  it('survives a full write -> store -> read round trip', () => {
    const literal = toHstoreLiteral({
      type: 'payment_reminder',
      owner_id: 53,
      user_ids: [5, 6],
      target: '/loan/53',
      message: 'x',
    });
    const decoded = decodeSchedulerPayload(parseHstore(literal));
    expect(decoded.user_ids).toEqual([5, 6]);
    expect(decoded.owner_id).toBe('53');
  });

  it('throws when user_ids is SQL NULL', () => {
    expect(() => decodeSchedulerPayload({ type: 'x', user_ids: null })).toThrow(TypeError);
  });

  // Condition C23 / finding S5, the Phase 7 half of the same defect.
  it('C23: throws a KeyError when user_ids is absent, not only when it is NULL', () => {
    expect(() => decodeSchedulerPayload({ type: 'x' })).toThrow("KeyError: 'user_ids'");
  });
});
