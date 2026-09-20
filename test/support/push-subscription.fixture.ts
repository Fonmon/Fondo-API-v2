/**
 * Push-subscription fixtures for the Phase 2 e2e suite.
 *
 * ## Provenance — these are not invented shapes
 *
 * {@link REAL_FCM_ROW} and {@link REAL_APPLE_ROW} are rows **160** and **1398** of
 * `fondo_api_notificationsubscriptions` in `fondodev`, written by v1 — **as Phase 9 step 6
 * left them**. Until stage 2a they were the `subscription::text` hstore renderings; the
 * migration turned those into the jsonb objects below, which is what a Release B read now
 * sees. Every structural property is preserved:
 *
 *  * **jsonb member order — `keys`, `endpoint`, `expirationTime`** — `(length, bytes)`, the
 *    same order hstore emitted, measured identical on all 720 migrated rows
 *    (`scripts/parity/step6-prove.sh`, the `keyorder` comparison). That order is part of the
 *    SQS wire format (plan §2);
 *  * `keys` is a real object, and its members are stored **`auth`, `p256dh`** because jsonb
 *    sorts them by (length, bytes). ⚠️ The **wire** order is the browser's, `p256dh, auth`,
 *    restored by `pinKeysMemberOrder` — condition **C91**, operator answer **Q60**. The two
 *    orders being different is the whole point of that pin;
 *  * `"expirationTime": null` on the FCM row, and **no `expirationTime` member at all** on
 *    the Apple one. Both shapes exist live (93 rows and 1 row respectively);
 *  * the same endpoint hosts, the same value lengths, the same base64url alphabet.
 *
 * ⚠️ **The random segments are substituted.** The base64url payloads (`p256dh`, `auth`, and
 * the FCM/APNs token) are replaced character-for-character with values from the same
 * alphabet and of the same length. A push endpoint plus its keys is a live credential and
 * does not belong in a git repository; nothing the decoder does depends on their content.
 *
 * ⚠️ **This is not a substitute for reading the real rows.** `notification.e2e-spec.ts` also
 * decodes **all 94 live rows** when `FONDODEV_DATABASE_URL` is set — see
 * *decodes every live subscription row* in that file, and the note for `manual-tester` in
 * `docs/phase-2-deviations.md`.
 */

/**
 * Row 160 — Chrome/FCM, `expirationTime` explicitly null. 93 rows look like this.
 * ⚠️ Member order is **stored** order: `keys` first, and inside it `auth` before `p256dh`.
 */
export const REAL_FCM_ROW = {
  keys: {
    auth: '9UPpnmcxRF8pIR6W5UF1B9',
    p256dh:
      'MM5gSdrFcjxy0r6kv_a1woF-5zX1wu8rxUgOwaQogJRv_kYDIG0nOy0B8Mlpxx6vzvVHdxZ1vGTYiVciNeb-vUv',
  },
  endpoint:
    'https://fcm.googleapis.com/fcm/send/V_7ZgJggH69:qOLcjqClTh852aLXdmEVHbpuniyuAsKsGhqmB3ZBDHOziea5eQCm9wg0VkFd0-OHxfkhT72EmMDXFUxt95JEMkepily-b2oSVSg-cccqY1yZO_SZX92w-lXJeeYF1wAe4SBecFmhRTsD',
  expirationTime: null,
};

/** Row 1398 — Safari/APNs, with **no** `expirationTime` member. The only such row live. */
export const REAL_APPLE_ROW = {
  keys: {
    auth: 'Xt6JzYwY-H8UzlZ24qDj6o',
    p256dh:
      'tS-o7KxQgoAGHkD7YJ16f1zYHnJalNu1Wv8-Nn80fkRVd7JumbYSWEohM9UHMzyEP3htdbuJ4FhIRO3S2eoOOkX',
  },
  endpoint:
    'https://web.push.apple.com/Tz_EM-ADAZ1hW7UPrb0y2E5RG0He5KXNwaR0KzGCQBq5wKIucTX_iP2AJ4Zjacgq8lX7E2-3ke-OH9ZJRcpVuoJBpDYjxNTYfuJvA7_T6QtVPt2jwNoZHKe6pHmCqEKlpaK9Wb6eOCAJo34n3tHVsCN5RtVVJuaFhuSCXsPgbO4',
};

/**
 * {@link REAL_FCM_ROW} **as it goes on the wire**: top level in jsonb's (length, bytes)
 * order, and `keys` with **`p256dh` first** — C91's pin (Q60).
 */
export const REAL_FCM_DECODED = {
  keys: {
    p256dh:
      'MM5gSdrFcjxy0r6kv_a1woF-5zX1wu8rxUgOwaQogJRv_kYDIG0nOy0B8Mlpxx6vzvVHdxZ1vGTYiVciNeb-vUv',
    auth: '9UPpnmcxRF8pIR6W5UF1B9',
  },
  endpoint:
    'https://fcm.googleapis.com/fcm/send/V_7ZgJggH69:qOLcjqClTh852aLXdmEVHbpuniyuAsKsGhqmB3ZBDHOziea5eQCm9wg0VkFd0-OHxfkhT72EmMDXFUxt95JEMkepily-b2oSVSg-cccqY1yZO_SZX92w-lXJeeYF1wAe4SBecFmhRTsD',
  expirationTime: null,
};

/** {@link REAL_APPLE_ROW} on the wire. Note: no `expirationTime` member. */
export const REAL_APPLE_DECODED = {
  keys: {
    p256dh:
      'tS-o7KxQgoAGHkD7YJ16f1zYHnJalNu1Wv8-Nn80fkRVd7JumbYSWEohM9UHMzyEP3htdbuJ4FhIRO3S2eoOOkX',
    auth: 'Xt6JzYwY-H8UzlZ24qDj6o',
  },
  endpoint:
    'https://web.push.apple.com/Tz_EM-ADAZ1hW7UPrb0y2E5RG0He5KXNwaR0KzGCQBq5wKIucTX_iP2AJ4Zjacgq8lX7E2-3ke-OH9ZJRcpVuoJBpDYjxNTYfuJvA7_T6QtVPt2jwNoZHKe6pHmCqEKlpaK9Wb6eOCAJo34n3tHVsCN5RtVVJuaFhuSCXsPgbO4',
};

/**
 * The `setUp` body from `fondo_api/tests/test_notification_views.py`, verbatim — including
 * `expirationTime: None`, which the JSON body carries as `null` and which Django stores as
 * SQL NULL rather than the string `'None'`.
 */
export const V1_TEST_SUBSCRIPTION = {
  endpoint:
    'https://fcm.googleapis.com/fcm/send/eX6bP7wJrF4:APA91bG3MLpEG28xFOuYLQc-AB78XRywxVFOtGQpGwUQp5NWc-6GYzjvgSdCIiI4U_cFsS22Qi9QPpdI3hZ1OjyO8LcAoSfmhnK31IaXJc7OhnaauHzToLZt7HpP9bZO59yIP8i5FWs5',
  expirationTime: null,
  keys: {
    p256dh:
      'BHUdL9eM2s6BoDOIl0zz68ZsPqY9wLAQC8CttBykmgZC1SU3U7wV6tKcJ4wjkj1-T_0qrsOqjzBmTcxvhUPilA4',
    auth: '60-ComhtIqES-C7GmbrDVg',
  },
};

/** `self.subscription_not_exist` from the same `setUp` — a different endpoint, same keys. */
export const V1_TEST_SUBSCRIPTION_NOT_EXIST = {
  endpoint:
    'https://fcm.googleapis.com/fcm/send/eX6bP7wJrF4:APA91bG3FOuYLQc-AB78XRywxVFOtGQpGwUQp5NWc-6GYzjvgSdCIiI4U_cFsS22Qi9QPpdI3hZ1OjyO8LcAoSfmhnK31IaXJc7OhnaauHzToLZt7HpP9bZO59yIP8i5FWs5',
  expirationTime: null,
  keys: {
    p256dh:
      'BHUdL9eM2s6BoDOIl0zz68ZsPqY9wLAQC8CttBykmgZC1SU3U7wV6tKcJ4wjkj1-T_0qrsOqjzBmTcxvhUPilA4',
    auth: '60-ComhtIqES-C7GmbrDVg',
  },
};
