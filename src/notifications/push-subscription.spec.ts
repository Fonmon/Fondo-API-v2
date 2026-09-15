import { pythonJsonDumps } from '../common/utils/python-json-dumps';
import {
  PINNED_KEYS_MEMBER_ORDER,
  pinKeysMemberOrder,
  type PushSubscription,
} from './push-subscription';

/**
 * **C91 (operator answer Q60) — the `keys` object goes on the wire as `p256dh`, then `auth`.**
 *
 * 🔴 These cells are the only thing holding that order. Before Phase 9 step 6 it came from the
 * stored Python repr, which the database no longer contains; after step 6, jsonb stores
 * `auth, p256dh` (length, then bytes) and the pin restores the browser's order at the emit
 * boundary. Delete `pinKeysMemberOrder` and nothing else in the system notices — which is
 * exactly why the mutation table below scores the wrong implementations rather than only the
 * right one.
 */
describe('pinKeysMemberOrder', () => {
  const stored = (): PushSubscription =>
    // Member order as jsonb yields it: `keys` first (4 < 8 < 14), `auth` before `p256dh`.
    ({
      keys: { auth: 'AUTH-VALUE', p256dh: 'P256DH-VALUE' },
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      expirationTime: null,
    });

  it('the pinned order is p256dh then auth — the browser’s, not the database’s', () => {
    expect(PINNED_KEYS_MEMBER_ORDER).toEqual(['p256dh', 'auth']);
  });

  it('reorders the keys members and leaves their values alone', () => {
    const pinned = pinKeysMemberOrder(stored());
    expect(Object.keys(pinned.keys)).toEqual(['p256dh', 'auth']);
    expect(pinned.keys).toEqual({ p256dh: 'P256DH-VALUE', auth: 'AUTH-VALUE' });
  });

  it('leaves the TOP-level member order alone — that one is already correct', () => {
    // jsonb's (length, bytes) order is the same order hstore emitted, measured identical on
    // all 720 migrated rows by `scripts/parity/step6-prove.sh`.
    expect(Object.keys(pinKeysMemberOrder(stored()))).toEqual([
      'keys',
      'endpoint',
      'expirationTime',
    ]);
  });

  it('is what the SQS body serialises — the assertion that would catch a flip', () => {
    const body = pythonJsonDumps({
      subscriptions: [pinKeysMemberOrder(stored())],
      message: { body: 'x', target: '/' },
    } as unknown as Parameters<typeof pythonJsonDumps>[0]);
    expect(body).toContain('"keys": {"p256dh": "P256DH-VALUE", "auth": "AUTH-VALUE"}');
    expect(body).not.toContain('"auth": "AUTH-VALUE", "p256dh"');
  });

  it('keeps an unexpected member instead of dropping it, after the pinned two', () => {
    const extended = {
      keys: { auth: 'A', zzz: 'Z', p256dh: 'P' },
      endpoint: 'https://x',
    } as unknown as PushSubscription;
    expect(Object.keys(pinKeysMemberOrder(extended).keys)).toEqual(['p256dh', 'auth', 'zzz']);
  });

  it('survives a keys object missing one of the pinned members', () => {
    const partial = { keys: { auth: 'A' }, endpoint: 'https://x' } as unknown as PushSubscription;
    expect(Object.keys(pinKeysMemberOrder(partial).keys)).toEqual(['auth']);
  });

  it.each([
    ['null', null],
    ['a string', "{'p256dh': 'x'}"],
    ['an array', ['p256dh', 'auth']],
  ])('returns a keys that is %s unchanged rather than inventing an order', (_label, keys) => {
    const odd = { keys, endpoint: 'https://x' } as unknown as PushSubscription;
    expect(pinKeysMemberOrder(odd).keys).toBe(keys);
  });

  it('is idempotent', () => {
    const once = pinKeysMemberOrder(stored());
    expect(Object.keys(pinKeysMemberOrder(once).keys)).toEqual(['p256dh', 'auth']);
  });

  /**
   * **Mutation controls.** Each row is a plausible re-implementation; the assertion above it
   * is the one that must reject it. A pin with no failing cell is a comment.
   */
  describe('mutation controls — wrong implementations of the pin', () => {
    const subscription = stored();
    const order = (keys: Record<string, string>): string[] => Object.keys(keys);

    it('MU-P1: no pin at all — the stored order reaches the wire', () => {
      expect(order(subscription.keys)).toEqual(['auth', 'p256dh']);
      expect(order(subscription.keys)).not.toEqual([...PINNED_KEYS_MEMBER_ORDER]);
    });

    it('MU-P2: alphabetical sort — looks deterministic, is the wrong order', () => {
      const sorted = Object.fromEntries(
        Object.entries(subscription.keys).sort(([a], [b]) => a.localeCompare(b)),
      );
      expect(order(sorted)).toEqual(['auth', 'p256dh']);
      expect(order(sorted)).not.toEqual([...PINNED_KEYS_MEMBER_ORDER]);
    });

    it('MU-P3: pinned order reversed', () => {
      const reversed = Object.fromEntries(['auth', 'p256dh'].map((k) => [k, subscription.keys[k]]));
      expect(order(reversed)).not.toEqual([...PINNED_KEYS_MEMBER_ORDER]);
    });

    it('MU-P4: rebuilt from the pinned list only — drops an unexpected member', () => {
      const extended = {
        keys: { auth: 'A', zzz: 'Z', p256dh: 'P' },
        endpoint: 'https://x',
      } as unknown as PushSubscription;
      const dropping = Object.fromEntries(
        PINNED_KEYS_MEMBER_ORDER.map((k) => [k, extended.keys[k]]),
      );
      expect(Object.keys(dropping)).not.toContain('zzz');
      // …which is what the real implementation does not do:
      expect(Object.keys(pinKeysMemberOrder(extended).keys)).toContain('zzz');
    });

    it('MU-P5: pinning the TOP level too — would move `keys` off the wire position', () => {
      const wrong = { endpoint: 'https://x', keys: {}, expirationTime: null };
      expect(Object.keys(wrong)).not.toEqual(Object.keys(pinKeysMemberOrder(stored())));
    });
  });
});
