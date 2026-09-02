import {
  csrfTokensMatch,
  CSRF_SECRET_LENGTH,
  maskCsrfSecret,
  newCsrfSecret,
  sanitizeCsrfToken,
  unmaskCsrfToken,
} from './django-csrf';

/**
 * `django.middleware.csrf`'s token format.
 *
 * ⚠️ The vectors below were produced by calling Django 2.2.27's own
 * `_salt_cipher_secret` / `_unsalt_cipher_token` **inside the v1 image** — 20 random pairs,
 * every one round-tripped through this implementation, 0 mismatches. Six are pinned here.
 * Nothing was hand-computed.
 */
const V1_VECTORS: readonly { secret: string; masked: string }[] = [
  {
    secret: 'bqCMHvbs5U8XDBBcjcbHvSj8XCzycTrB',
    masked: 'eIfh7dDJvGAzXSu5ZNfXlEEOdI7ilwGCfYHTEyE1qqymqjV78PguGmNM0awGnfX3',
  },
  {
    secret: 'HFUMnzFcfXbvIoC21TszCXGVcMINhxxL',
    masked: 'xAykLtAesoOkC1DDD6zwycKoPsRvlg5145iWYS5gxbPFaf5vuPRV0Zg9R4p8sDsC',
  },
  {
    secret: 'S2pNoUv9clvDAm9HsblQRTIfHLPw3JiG',
    masked: 'fTxvRWC9WKvsQKCdNv2LDuCJeFCGp7jYXLM85GX8YVQVgWBK5wdrkdaOLgh2iGru',
  },
  {
    secret: '1lWmRrB1T5NOESa4PQADz1qowxYU6NsQ',
    masked: 'zDdpdXJBzbtzqJaoscEDstMasaz02c8LqOZBUeasi66dUrai7S46Rk2oOxnKYPqr',
  },
  {
    secret: 'QSueVOG90wF482kf75cyPJonGmzHiMQE',
    masked: 'SXuDGeQy8NdXWg6iLfdklWlMp8cwY1lHyFOHrSmxY9IRU8gnIafI0vzZVkB36D1b',
  },
  {
    secret: '84U1Y607djDvfI3QN26tP7eRj3bLF13B',
    masked: 'AsBnyeK3VFYXPf9sAi4TGMGpOFT9PCASymlemaA0YOriUN28da0clJK6XyUKkttj',
  },
];

describe('django-csrf', () => {
  it('unmasks Django 2.2.27’s own tokens', () => {
    for (const vector of V1_VECTORS) {
      expect(unmaskCsrfToken(vector.masked)).toBe(vector.secret);
    }
  });

  it('re-masks with Django’s salt and reproduces the same token', () => {
    for (const vector of V1_VECTORS) {
      const salt = vector.masked.slice(0, CSRF_SECRET_LENGTH);
      expect(maskCsrfSecret(vector.secret, salt)).toBe(vector.masked);
    }
  });

  it('produces a different token every time, from the same secret', () => {
    const secret = newCsrfSecret();
    const first = maskCsrfSecret(secret);
    const second = maskCsrfSecret(secret);
    expect(first).not.toBe(second);
    expect(unmaskCsrfToken(first)).toBe(secret);
    expect(unmaskCsrfToken(second)).toBe(secret);
    // …and the two compare equal, which is the whole point of the masking.
    expect(csrfTokensMatch(first, second)).toBe(true);
  });

  it('generates a 32-character secret from [a-zA-Z0-9]', () => {
    for (let i = 0; i < 20; i += 1) {
      expect(newCsrfSecret()).toMatch(/^[a-zA-Z0-9]{32}$/);
    }
  });

  it('refuses two masks of different secrets', () => {
    expect(csrfTokensMatch(maskCsrfSecret(newCsrfSecret()), maskCsrfSecret(newCsrfSecret()))).toBe(
      false,
    );
  });

  describe('unmaskCsrfToken', () => {
    it('returns a legacy 32-character token unchanged', () => {
      const legacy = newCsrfSecret();
      expect(unmaskCsrfToken(legacy)).toBe(legacy);
    });

    it('rejects a wrong length or a non-alphanumeric character', () => {
      expect(unmaskCsrfToken('short')).toBeNull();
      expect(unmaskCsrfToken('!'.repeat(64))).toBeNull();
      expect(unmaskCsrfToken('')).toBeNull();
    });
  });

  describe('sanitizeCsrfToken — `_sanitize_token`', () => {
    it('keeps a well-formed 64-character token', () => {
      const token = maskCsrfSecret(newCsrfSecret());
      expect(sanitizeCsrfToken(token)).toEqual({ token, replaced: false });
    });

    it('salts a legacy 32-character cookie and flags it for reset', () => {
      const legacy = newCsrfSecret();
      const result = sanitizeCsrfToken(legacy);
      expect(result.replaced).toBe(true);
      expect(unmaskCsrfToken(result.token)).toBe(legacy);
    });

    it('replaces anything else, rather than throwing', () => {
      for (const bad of [undefined, '', 'nope', '!'.repeat(64)]) {
        const result = sanitizeCsrfToken(bad);
        expect(result.replaced).toBe(true);
        expect(result.token).toMatch(/^[a-zA-Z0-9]{64}$/);
      }
    });
  });

  it('csrfTokensMatch is total — a malformed side is a refusal, not an exception', () => {
    const good = maskCsrfSecret(newCsrfSecret());
    expect(csrfTokensMatch(good, '')).toBe(false);
    expect(csrfTokensMatch('', good)).toBe(false);
    expect(csrfTokensMatch(good, 'nonsense')).toBe(false);
  });
});
