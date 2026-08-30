import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { RolesGuard } from './guards/roles.guard';
import { TokenAuthGuard } from './guards/token-auth.guard';
import { DjangoPasswordService } from './password/django-password.service';

/**
 * Phase 1 — DRF token authentication and the role matrix.
 *
 * The two guards are registered **globally and in DRF's order**:
 *
 *  1. {@link TokenAuthGuard} ≡ `APIView.perform_authentication` (the
 *     `DEFAULT_AUTHENTICATION_CLASSES` pass),
 *  2. {@link RolesGuard} ≡ `APIView.check_permissions` (`IsAuthenticated` then
 *     `APIRolePermission`).
 *
 * Nest runs `APP_GUARD` providers in registration order, and the order is load-bearing: a
 * bad token must produce `401 Invalid token.` from the authenticator, never
 * `401 Authentication credentials were not provided.` from the permission layer.
 *
 * Registering them globally is also what makes the default-deny real. If guards were opt-in
 * per controller, forgetting the decorator would publish an open endpoint; as it stands,
 * forgetting `@V1View(...)` makes the endpoint **unreachable**, which is a loud, safe
 * failure. `AppModule` imports this module for that reason alone — Phase 1 ships exactly one
 * route.
 */
@Module({
  imports: [PrismaModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    DjangoPasswordService,
    { provide: APP_GUARD, useClass: TokenAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [AuthService, DjangoPasswordService],
})
export class AuthModule {}
