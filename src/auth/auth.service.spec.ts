import { AuthService } from './auth.service';
import { DjangoPasswordService } from './password/django-password.service';
import { Role } from './permissions/roles';
import type { PrismaService } from '../prisma/prisma.service';
import { DrfException } from '../common/http/drf.exception';

/** `password` hashed by Django 2.2's `create_user()`. See django-password.service.spec.ts. */
const PASSWORD_HASH =
  'pbkdf2_sha256$150000$IcN4POfP8zno$dE8sG5SDDZYFHQNRreb7zFGtiLAXO1IXIA6zdem2w+A=';
const EXISTING_KEY = 'b'.repeat(40);

interface PrismaStub {
  authUser: { findUnique: jest.Mock };
  authToken: { findUnique: jest.Mock; create: jest.Mock };
}

function makeService(): { service: AuthService; prisma: PrismaStub } {
  const prisma: PrismaStub = {
    authUser: { findUnique: jest.fn() },
    authToken: { findUnique: jest.fn(), create: jest.fn() },
  };
  const service = new AuthService(prisma as unknown as PrismaService, new DjangoPasswordService());
  return { service, prisma };
}

const INVALID_CREDENTIALS = {
  non_field_errors: ['Unable to log in with provided credentials.'],
};

describe('AuthService.login (ObtainAuthToken.post)', () => {
  it('returns the existing token — get_or_create never rotates', async () => {
    const { service, prisma } = makeService();
    prisma.authUser.findUnique.mockResolvedValue({
      id: 7,
      password: PASSWORD_HASH,
      is_active: true,
    });
    prisma.authToken.findUnique.mockResolvedValue({ key: EXISTING_KEY });

    await expect(
      service.login({ username: 'mail_for_tests@mail.com', password: 'password' }),
    ).resolves.toEqual({ token: EXISTING_KEY });
    expect(prisma.authToken.create).not.toHaveBeenCalled();
  });

  it('creates a 40-hex-character token on first login and sets `created` explicitly', async () => {
    const { service, prisma } = makeService();
    prisma.authUser.findUnique.mockResolvedValue({
      id: 7,
      password: PASSWORD_HASH,
      is_active: true,
    });
    prisma.authToken.findUnique.mockResolvedValue(null);
    prisma.authToken.create.mockImplementation((args: { data: { key: string } }) =>
      Promise.resolve({ key: args.data.key }),
    );

    const result = await service.login({ username: 'a@b.com', password: 'password' });
    expect(result.token).toMatch(/^[0-9a-f]{40}$/);

    const createCalls = prisma.authToken.create.mock.calls as unknown as [
      { data: { key: string; user_id: number; created: Date } },
    ][];
    const created = createCalls[0][0];
    expect(created.data.user_id).toBe(7);
    // `created` is auto_now_add in Django — application-set, no DB default (rule §4.5).
    expect(created.data.created).toBeInstanceOf(Date);
  });

  it('looks the user up by auth_user.username, not by email', () => {
    // AUTH_USER_MODEL is Django's default, so ModelBackend resolves get_by_natural_key
    // against User.USERNAME_FIELD == 'username'. v1 keeps username == email on every write
    // path, which is why the two agree in the data.
    const { service, prisma } = makeService();
    prisma.authUser.findUnique.mockResolvedValue(null);
    return service
      .login({ username: 'a@b.com', password: 'password' })
      .catch(() => undefined)
      .then(() => {
        expect(prisma.authUser.findUnique).toHaveBeenCalledWith(
          expect.objectContaining({ where: { username: 'a@b.com' } }),
        );
      });
  });

  it('400s with non_field_errors for a wrong password', async () => {
    const { service, prisma } = makeService();
    prisma.authUser.findUnique.mockResolvedValue({
      id: 7,
      password: PASSWORD_HASH,
      is_active: true,
    });
    await expect(service.login({ username: 'a@b.com', password: 'nope' })).rejects.toMatchObject({
      drfBody: INVALID_CREDENTIALS,
    });
  });

  it('400s with the same body for an unknown user — no enumeration oracle', async () => {
    const { service, prisma } = makeService();
    prisma.authUser.findUnique.mockResolvedValue(null);
    await expect(
      service.login({ username: 'nobody@b.com', password: 'password' }),
    ).rejects.toMatchObject({ drfBody: INVALID_CREDENTIALS });
  });

  it('400s with the same body for a deactivated member', async () => {
    // `ModelBackend.user_can_authenticate` -> is_active. Soft-deleted users
    // (`DELETE /api/user/<id>` sets is_active = false) cannot log in.
    const { service, prisma } = makeService();
    prisma.authUser.findUnique.mockResolvedValue({
      id: 7,
      password: PASSWORD_HASH,
      is_active: false,
    });
    await expect(
      service.login({ username: 'a@b.com', password: 'password' }),
    ).rejects.toMatchObject({ drfBody: INVALID_CREDENTIALS });
  });

  it("hashes anyway when the user does not exist (Django's timing mitigation)", async () => {
    const { service, prisma } = makeService();
    prisma.authUser.findUnique.mockResolvedValue(null);
    const passwords = new DjangoPasswordService();
    const spy = jest.spyOn(DjangoPasswordService.prototype, 'hash');
    const timed = new AuthService(prisma as unknown as PrismaService, passwords);
    await expect(
      timed.login({ username: 'nobody@b.com', password: 'password' }),
    ).rejects.toBeInstanceOf(DrfException);
    expect(spy).toHaveBeenCalledWith('password');
    spy.mockRestore();
    expect(service).toBeDefined();
  });

  it('never touches last_login — DRF calls authenticate(), not login()', async () => {
    const { service, prisma } = makeService();
    prisma.authUser.findUnique.mockResolvedValue({
      id: 7,
      password: PASSWORD_HASH,
      is_active: true,
    });
    prisma.authToken.findUnique.mockResolvedValue({ key: EXISTING_KEY });
    await service.login({ username: 'a@b.com', password: 'password' });
    // The stub exposes no update method; using one would throw.
    expect(Object.keys(prisma.authUser)).toEqual(['findUnique']);
  });

  it('rejects an invalid payload before touching the database', async () => {
    const { service, prisma } = makeService();
    await expect(service.login({})).rejects.toMatchObject({
      drfBody: {
        username: ['This field is required.'],
        password: ['This field is required.'],
      },
    });
    expect(prisma.authUser.findUnique).not.toHaveBeenCalled();
  });
});

describe('AuthService.authenticateByTokenKey (TokenAuthentication.authenticate_credentials)', () => {
  it('returns null for an unknown key', async () => {
    const { service, prisma } = makeService();
    prisma.authToken.findUnique.mockResolvedValue(null);
    await expect(service.authenticateByTokenKey('x'.repeat(40))).resolves.toBeNull();
  });

  it('joins both halves of the UserProfile(User) multi-table inheritance', async () => {
    const { service, prisma } = makeService();
    prisma.authToken.findUnique.mockResolvedValue({
      key: EXISTING_KEY,
      created: new Date('2022-01-01T00:00:00Z'),
      user: {
        id: 7,
        username: 'a@b.com',
        email: 'a@b.com',
        is_active: true,
        profile: { role: Role.TREASURER, identification: 99999n },
      },
    });
    await expect(service.authenticateByTokenKey(EXISTING_KEY)).resolves.toEqual({
      token: { key: EXISTING_KEY, created: new Date('2022-01-01T00:00:00Z') },
      user: {
        id: 7,
        username: 'a@b.com',
        email: 'a@b.com',
        isActive: true,
        profile: { role: Role.TREASURER, identification: 99999n },
      },
    });
  });

  it('tolerates an auth_user row with no fondo_api_userprofile sibling', async () => {
    // v1 answers 403 for these, not 500, because APIRolePermission swallows the
    // RelatedObjectDoesNotExist. The guard needs a null profile, not an exception.
    const { service, prisma } = makeService();
    prisma.authToken.findUnique.mockResolvedValue({
      key: EXISTING_KEY,
      created: new Date(),
      user: {
        id: 1,
        username: 'root',
        email: '',
        is_active: true,
        profile: null,
      },
    });
    const result = await service.authenticateByTokenKey(EXISTING_KEY);
    expect(result?.user.profile).toBeNull();
  });
});
