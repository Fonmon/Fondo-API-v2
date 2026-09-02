import type { AppConfigService } from '../config/app-config.service';
import {
  PasswordResetTokenService,
  urlsafeBase64Decode,
  urlsafeBase64Encode,
  type ResetTokenSubject,
} from './password-reset-token.service';

const config = { secretKey: 'parity-test-secret-key' } as AppConfigService;

const user: ResetTokenSubject = {
  id: 7,
  password: 'pbkdf2_sha256$150000$abc$def=',
  last_login: null,
};

describe('PasswordResetTokenService', () => {
  const tokens = new PasswordResetTokenService(config);

  it('produces a token the v1 URL pattern accepts', () => {
    // `api/urls.py:24`: `[0-9A-Za-z]{1,13}-[0-9A-Za-z]{1,20}`. A token outside it would 404 at
    // the resolver before any view ran.
    expect(tokens.makeToken(user)).toMatch(/^[0-9A-Za-z]{1,13}-[0-9A-Za-z]{1,20}$/);
  });

  it('accepts its own token', () => {
    expect(tokens.checkToken(user, tokens.makeToken(user))).toBe(true);
  });

  it('is bound to the user id', () => {
    const token = tokens.makeToken(user);
    expect(tokens.checkToken({ ...user, id: 8 }, token)).toBe(false);
  });

  it('dies when the password changes — this is what makes the link single-use', () => {
    const token = tokens.makeToken(user);
    expect(tokens.checkToken({ ...user, password: 'pbkdf2_sha256$150000$xyz$new=' }, token)).toBe(
      false,
    );
  });

  it('dies when the member logs in', () => {
    const token = tokens.makeToken(user);
    expect(tokens.checkToken({ ...user, last_login: new Date('2026-01-01') }, token)).toBe(false);
  });

  it('expires after PASSWORD_RESET_TIMEOUT_DAYS = 3, and not before', () => {
    const issued = new Date('2026-05-01T00:00:00Z');
    const token = tokens.makeToken(user, issued);

    expect(tokens.checkToken(user, token, new Date('2026-05-03T23:59:00Z'))).toBe(true);
    expect(tokens.checkToken(user, token, new Date('2026-05-04T00:00:01Z'))).toBe(false);
  });

  it('refuses a token from the future', () => {
    const token = tokens.makeToken(user, new Date('2026-05-10T00:00:00Z'));
    expect(tokens.checkToken(user, token, new Date('2026-05-01T00:00:00Z'))).toBe(false);
  });

  it('is total — every malformed shape is a refusal, never an exception', () => {
    for (const bad of ['', '-', 'abc', 'zzzzzzzzzzzzzzzz-abc', '!!-!!', null, undefined]) {
      expect(tokens.checkToken(user, bad)).toBe(false);
    }
    expect(tokens.checkToken(null, tokens.makeToken(user))).toBe(false);
  });

  it('changes with the signing key, so a leaked v1 token cannot be reused', () => {
    const other = new PasswordResetTokenService({ secretKey: 'different' } as AppConfigService);
    expect(other.checkToken(user, tokens.makeToken(user))).toBe(false);
  });

  describe('urlsafe_base64_encode / decode', () => {
    it('encodes the decimal id, as `force_bytes(user.pk)` does', () => {
      // Django: `urlsafe_base64_encode(force_bytes(7))` -> 'Nw'
      expect(urlsafeBase64Encode('7')).toBe('Nw');
      expect(urlsafeBase64Encode('123')).toBe('MTIz');
    });

    it('round-trips', () => {
      for (const id of ['1', '7', '15', '2147483647']) {
        expect(urlsafeBase64Decode(urlsafeBase64Encode(id))).toBe(id);
      }
    });

    it('produces only characters the URL pattern allows', () => {
      for (let id = 1; id < 200; id += 1) {
        expect(urlsafeBase64Encode(String(id))).toMatch(/^[0-9A-Za-z_-]+$/);
      }
    });

    it('returns null rather than throwing for a segment outside the alphabet', () => {
      expect(urlsafeBase64Decode('!!')).toBeNull();
    });
  });
});
