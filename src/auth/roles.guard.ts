import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY, RoleRequirement } from './roles.decorator';
import { UserContext } from './auth.service';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requirement = this.reflector.getAllAndOverride<
      RoleRequirement | undefined
    >(ROLES_KEY, [context.getHandler(), context.getClass()]);

    if (!requirement) return true;

    const request = context.switchToHttp().getRequest<{ user?: UserContext }>();
    const user = request.user;
    if (!user) return false;

    if ('maxRole' in requirement) {
      return user.role <= requirement.maxRole;
    }
    return requirement.exactRoles.includes(user.role);
  }
}
