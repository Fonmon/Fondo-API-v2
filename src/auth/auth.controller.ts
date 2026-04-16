import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  BadRequestException,
  Post,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { Public } from './public.decorator';

class LoginDto {
  username!: string;
  password!: string;
}

class PasswordResetRequestDto {
  email!: string;
}

class PasswordResetConfirmDto {
  token!: string;
  new_password!: string;
}

@Public()
@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('api-token-auth')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto): Promise<{ token: string }> {
    const result = await this.auth.login(dto.username, dto.password);
    if (!result) throw new BadRequestException('Invalid credentials');
    return result;
  }

  @Post('password_reset')
  @HttpCode(HttpStatus.OK)
  async requestReset(@Body() dto: PasswordResetRequestDto): Promise<void> {
    await this.auth.requestPasswordReset(dto.email);
  }

  @Post('password_reset/confirm')
  @HttpCode(HttpStatus.OK)
  async confirmReset(@Body() dto: PasswordResetConfirmDto): Promise<void> {
    await this.auth.confirmPasswordReset(dto.token, dto.new_password);
  }
}
