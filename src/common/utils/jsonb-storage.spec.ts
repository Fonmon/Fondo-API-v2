import { encodeJsonbColumn } from './jsonb-storage';

/**
 * The write-side rule for the two columns Phase 9 step 6 converted — `jsonb-storage.ts`.
 *
 * The single fact every cell here defends: **a row v2 writes after step 6 must be
 * indistinguishable from one the migration produced.** `owner_id` is the string `"9"` in all
 * 626 migrated scheduler rows, so a v2 row holding the number `9` is invisible to the dedupe
 * filter — which compares it as text — and the member gets the same reminder twice in a day,
 * or a reminder for a loan already paid.
 */
describe('encodeJsonbColumn', () => {
  const SCHEDULER_NATIVE = ['user_ids'] as const;
  const SUBSCRIPTION_NATIVE = ['keys'] as const;

  it('writes a scheduler payload exactly as step 6 left the migrated rows', () => {
    expect(
      encodeJsonbColumn(
        {
          type: 'payment_reminder',
          owner_id: 53,
          user_ids: [5],
          target: '/loan/53',
          message: 'Recuerde que la fecha límite de pago para el crédito 53, es el: 9 sept. 2099',
        },
        SCHEDULER_NATIVE,
      ),
    ).toEqual({
      type: 'payment_reminder',
      // 🔴 A **string**, not the number that was passed in.
      owner_id: '53',
      // …and a real array, because step 6 unwrapped this one member.
      user_ids: [5],
      target: '/loan/53',
      message: 'Recuerde que la fecha límite de pago para el crédito 53, es el: 9 sept. 2099',
    });
  });

  it('writes a push subscription exactly as step 6 left the migrated rows', () => {
    expect(
      encodeJsonbColumn(
        {
          endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
          expirationTime: null,
          keys: { p256dh: 'P', auth: 'A' },
        },
        SUBSCRIPTION_NATIVE,
      ),
    ).toEqual({
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      // SQL NULL became JSON null in the migration; a fresh row matches.
      expirationTime: null,
      keys: { p256dh: 'P', auth: 'A' },
    });
  });

  it('keeps the object’s own member order, so the caller decides the wire order', () => {
    const encoded = encodeJsonbColumn(
      { keys: { p256dh: 'P', auth: 'A' }, endpoint: 'e', expirationTime: null },
      SUBSCRIPTION_NATIVE,
    );
    expect(Object.keys(encoded)).toEqual(['keys', 'endpoint', 'expirationTime']);
    expect(Object.keys(encoded.keys as Record<string, string>)).toEqual(['p256dh', 'auth']);
  });

  it('maps undefined to null, like the SQL NULL an hstore value used to be', () => {
    expect(encodeJsonbColumn({ a: undefined, b: null }, [])).toEqual({ a: null, b: null });
  });

  it('applies Django’s str(), not JSON.stringify, to a non-native structured value', () => {
    // A client can send `{"endpoint": [1, 2]}`; v1 stored the Python repr and answered 200.
    expect(encodeJsonbColumn({ endpoint: [1, 2] }, SUBSCRIPTION_NATIVE).endpoint).toBe('[1, 2]');
    expect(encodeJsonbColumn({ endpoint: { a: 'b' } }, SUBSCRIPTION_NATIVE).endpoint).toBe(
      "{'a': 'b'}",
    );
  });

  /**
   * **Mutation controls.** Each is a re-implementation someone could reach for now that the
   * column takes JSON, with the assertion that rejects it.
   */
  describe('mutation controls — wrong implementations of the storage rule', () => {
    const payload = { type: 'birthdate', owner_id: 9, user_ids: [2, 4] };

    it('MU-J1: store the values as they arrive — owner_id becomes a JSON number', () => {
      const naive = { ...payload };
      expect(typeof naive.owner_id).toBe('number');
      expect(typeof encodeJsonbColumn(payload, SCHEDULER_NATIVE).owner_id).toBe('string');
    });

    it('MU-J2: stringify EVERYTHING — user_ids goes back to being doubly stringified', () => {
      const overzealous = encodeJsonbColumn(payload, []);
      expect(overzealous.user_ids).toBe('[2, 4]');
      // …which is the shape the step-6 repair pass existed to remove:
      expect(encodeJsonbColumn(payload, SCHEDULER_NATIVE).user_ids).toEqual([2, 4]);
    });

    it('MU-J3: the wrong native key — `keys` left stringified on a subscription', () => {
      const wrong = encodeJsonbColumn({ keys: { auth: 'A' } }, SCHEDULER_NATIVE);
      expect(typeof wrong.keys).toBe('string');
      expect(typeof encodeJsonbColumn({ keys: { auth: 'A' } }, SUBSCRIPTION_NATIVE).keys).toBe(
        'object',
      );
    });

    it('MU-J4: JSON.stringify instead of str() — quotes a list the wrong way', () => {
      expect(JSON.stringify([1, 2])).toBe('[1,2]');
      // v1 stored `'[1, 2]'`, with the space, and 626 migrated rows carry that spacing in
      // every reminder that was written before step 6 unwrapped `user_ids`.
      expect(encodeJsonbColumn({ x: [1, 2] }, []).x).toBe('[1, 2]');
    });

    it('MU-J5: dropping null members instead of storing JSON null', () => {
      const encoded = encodeJsonbColumn({ expirationTime: null }, SUBSCRIPTION_NATIVE);
      expect(Object.prototype.hasOwnProperty.call(encoded, 'expirationTime')).toBe(true);
      expect(encoded.expirationTime).toBeNull();
    });
  });
});
