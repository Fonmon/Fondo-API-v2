import type { ExecutionContext } from '@nestjs/common';
import { DrfException } from '../../common/http/drf.exception';
import type { AuthService } from '../auth.service';
import { Role } from '../permissions/roles';
import type { RequestWithUser } from '../types/authenticated-user';
import { TokenAuthGuard, extractTokenKey } from './token-auth.guard';

const KEY = 'a'.repeat(40);

function httpContext(request: Record<string, unknown>): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

type Authentication = NonNullable<Awaited<ReturnType<AuthService['authenticateByTokenKey']>>>;

function authentication(overrides: { isActive?: boolean } = {}): Authentication {
  return {
    token: { key: KEY, created: new Date('2022-01-01T00:00:00Z') },
    user: {
      id: 7,
      username: 'a@b.com',
      email: 'a@b.com',
      isActive: overrides.isActive ?? true,
      profile: { role: Role.MEMBER, identification: 99999n },
    },
  };
}

function expectDrf(fn: () => unknown, status: number, detail: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DrfException);
    const drf = error as DrfException;
    expect(drf.getStatus()).toBe(status);
    expect(drf.drfBody).toEqual({ detail });
    expect(drf.drfHeaders).toEqual({ 'WWW-Authenticate': 'Token' });
    return;
  }
  throw new Error('expected a DrfException');
}

describe('extractTokenKey (rest_framework/authentication.py:TokenAuthentication)', () => {
  it('returns null when there is no Authorization header — not an error', () => {
    // DRF returns None and lets IsAuthenticated produce the 401 later, with a different body.
    expect(extractTokenKey(undefined)).toBeNull();
    expect(extractTokenKey('')).toBeNull();
    expect(extractTokenKey('   ')).toBeNull();
  });

  it('returns null for a scheme that is not Token', () => {
    expect(extractTokenKey(`Bearer ${KEY}`)).toBeNull();
    expect(extractTokenKey(`Basic ${KEY}`)).toBeNull();
  });

  it('matches the scheme case-insensitively', () => {
    // `auth[0].lower() != self.keyword.lower().encode()`
    expect(extractTokenKey(`Token ${KEY}`)).toBe(KEY);
    expect(extractTokenKey(`token ${KEY}`)).toBe(KEY);
    expect(extractTokenKey(`TOKEN ${KEY}`)).toBe(KEY);
  });

  it('collapses runs of whitespace the way bytes.split() does', () => {
    expect(extractTokenKey(`Token   ${KEY}`)).toBe(KEY);
    expect(extractTokenKey(`  Token ${KEY}  `)).toBe(KEY);
    expect(extractTokenKey(`Token\t${KEY}`)).toBe(KEY);
  });

  it('401s on the keyword with no credentials', () => {
    expectDrf(
      () => extractTokenKey('Token'),
      401,
      'Invalid token header. No credentials provided.',
    );
  });

  it('401s on a token containing spaces', () => {
    expectDrf(
      () => extractTokenKey('Token a b'),
      401,
      'Invalid token header. Token string should not contain spaces.',
    );
    expectDrf(
      () => extractTokenKey('Token a b c'),
      401,
      'Invalid token header. Token string should not contain spaces.',
    );
  });

  it('401s on a token that is not valid UTF-8 once decoded from the header encoding', () => {
    // Django reads headers as iso-8859-1 then `.decode()`s the token as UTF-8;
    // a lone 0xF1 byte ('ñ' in latin-1) is not valid UTF-8.
    expectDrf(
      () => extractTokenKey('Token ñ'),
      401,
      'Invalid token header. Token string should not contain invalid characters.',
    );
  });
});

describe('TokenAuthGuard', () => {
  function guardWith(result: Authentication | null): {
    guard: TokenAuthGuard;
    authenticateByTokenKey: jest.Mock;
  } {
    const authenticateByTokenKey = jest.fn().mockResolvedValue(result);
    const authService = { authenticateByTokenKey } as unknown as AuthService;
    return { guard: new TokenAuthGuard(authService), authenticateByTokenKey };
  }

  it('passes an anonymous request through untouched', async () => {
    const { guard, authenticateByTokenKey } = guardWith(null);
    const request: Record<string, unknown> = { headers: {} };
    await expect(guard.canActivate(httpContext(request))).resolves.toBe(true);
    expect(authenticateByTokenKey).not.toHaveBeenCalled();
    expect((request as RequestWithUser).authUser).toBeUndefined();
  });

  it('attaches the user and token on success', async () => {
    const { guard } = guardWith(authentication());
    const request: Record<string, unknown> = { headers: { authorization: `Token ${KEY}` } };
    await expect(guard.canActivate(httpContext(request))).resolves.toBe(true);
    expect((request as RequestWithUser).authUser).toMatchObject({ id: 7, username: 'a@b.com' });
    expect((request as RequestWithUser).authToken?.key).toBe(KEY);
  });

  it('401s "Invalid token." for an unknown key', async () => {
    const { guard } = guardWith(null);
    await expect(
      guard.canActivate(httpContext({ headers: { authorization: `Token ${KEY}` } })),
    ).rejects.toMatchObject({ drfBody: { detail: 'Invalid token.' } });
  });

  it('401s "User inactive or deleted." for a deactivated member', async () => {
    const { guard } = guardWith(authentication({ isActive: false }));
    await expect(
      guard.canActivate(httpContext({ headers: { authorization: `Token ${KEY}` } })),
    ).rejects.toMatchObject({ drfBody: { detail: 'User inactive or deleted.' } });
  });

  it('authenticates before permissions, so it also runs for @Public() routes', async () => {
    // v1: `permission_classes = []` clears permissions, never authenticators. A bad token on
    // POST /api-token-auth is a 401, not a login attempt. Verified against the v1 stack.
    const { guard, authenticateByTokenKey } = guardWith(null);
    await expect(
      guard.canActivate(httpContext({ headers: { authorization: `Token ${KEY}` } })),
    ).rejects.toBeInstanceOf(DrfException);
    expect(authenticateByTokenKey).toHaveBeenCalledWith(KEY);
  });

  it('does nothing outside an HTTP context', async () => {
    const { guard } = guardWith(null);
    const context = { getType: () => 'rpc' } as unknown as ExecutionContext;
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });
});
