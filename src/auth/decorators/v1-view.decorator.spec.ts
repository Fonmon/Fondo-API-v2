import { Controller } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { V1View, V1_VIEW_KEY } from './v1-view.decorator';
import { IS_PUBLIC_KEY, Public } from './public.decorator';

describe('@V1View', () => {
  it('records the v1 view-class name as route metadata', () => {
    @V1View('LoanView')
    @Controller('api/loan')
    class LoanController {}

    expect(new Reflector().get(V1_VIEW_KEY, LoanController)).toBe('LoanView');
  });

  it('throws at decoration time for a name that is not in list_permissions', () => {
    // A typo is already a compile error (`V1ViewName` is a literal union). This is the
    // runtime belt: it fires for a cast or a JavaScript caller, at import time, so a bad
    // name can never degrade into a route that is silently denied.
    // @ts-expect-error deliberately bypassing the compile-time check
    expect(() => V1View('LoanViw')).toThrow(/does not match any entry/);
  });

  it('names every known view in the error, so the fix is obvious', () => {
    // @ts-expect-error deliberately bypassing the compile-time check
    expect(() => V1View('Nope')).toThrow(/SavingAccountView/);
  });
});

describe('@Public', () => {
  it('records the flag v1 expresses as `permission_classes = []`', () => {
    @Public()
    @Controller()
    class LoginController {}

    expect(new Reflector().get(IS_PUBLIC_KEY, LoginController)).toBe(true);
  });
});
