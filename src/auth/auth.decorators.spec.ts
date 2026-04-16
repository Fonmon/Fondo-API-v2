import { IS_PUBLIC_KEY, Public } from './public.decorator';
import { ROLES_KEY, MaxRole, ExactRoles } from './roles.decorator';

describe('Public decorator', () => {
  it('sets isPublic metadata to true', () => {
    class Target {}
    Public()(Target);
    const meta = Reflect.getMetadata(IS_PUBLIC_KEY, Target);
    expect(meta).toBe(true);
  });
});

describe('MaxRole decorator', () => {
  it('sets ROLES_KEY metadata with maxRole', () => {
    class Target {}
    MaxRole(3)(Target);
    const meta = Reflect.getMetadata(ROLES_KEY, Target);
    expect(meta).toEqual({ maxRole: 3 });
  });
});

describe('ExactRoles decorator', () => {
  it('sets ROLES_KEY metadata with exactRoles list', () => {
    class Target {}
    ExactRoles(0, 2)(Target);
    const meta = Reflect.getMetadata(ROLES_KEY, Target);
    expect(meta).toEqual({ exactRoles: [0, 2] });
  });
});
