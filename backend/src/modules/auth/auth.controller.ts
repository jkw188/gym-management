import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CookieOptions, Request, Response } from 'express';
import { ApplicationError } from '../../common/errors/application-error';
import { ErrorResponseDto } from '../../common/http/error.dto';
import { normalizePhone } from '../../common/utils/normalization';
import { CurrentUser, Public } from './auth.decorators';
import { AuthOriginGuard } from './auth.guards';
import { AuthService } from './auth.service';
import { AuthPrincipal } from './auth.types';
import { LoginLimiter } from './login-limiter.service';
import { AuthResponseDto, LoginDto, PrincipalDto } from './login.dto';

export function refreshCookieOptions(nodeEnv: string, frontendOrigin: string, expiresAt: Date): CookieOptions {
  const hostname = new URL(frontendOrigin).hostname;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
  return { httpOnly: true, sameSite: 'lax', path: '/api/auth', secure: nodeEnv === 'production' || !local, expires: expiresAt };
}

@ApiTags('auth')
@ApiResponse({ status: 400, type: ErrorResponseDto })
@ApiResponse({ status: 401, type: ErrorResponseDto })
@ApiResponse({ status: 403, type: ErrorResponseDto })
@ApiResponse({ status: 503, type: ErrorResponseDto })
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly limiter: LoginLimiter, private readonly config: ConfigService) {}

  private respond(result: Awaited<ReturnType<AuthService['login']>>, response: Response) {
    response.cookie('gym_refresh', result.refreshToken, refreshCookieOptions(this.config.getOrThrow<string>('nodeEnv'),
      this.config.getOrThrow<string>('frontendOrigin'), result.expiresAt));
    return result.body;
  }

  @Public() @UseGuards(AuthOriginGuard) @Post('login') @HttpCode(200)
  @ApiOkResponse({ type: AuthResponseDto })
  @ApiResponse({ status: 429, type: ErrorResponseDto, headers: { 'Retry-After': { schema: { type: 'integer' } } } })
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const phone = normalizePhone(dto.phone);
    const retryAfter = this.limiter.consume(req.ip ?? req.socket.remoteAddress ?? 'unknown', phone);
    if (retryAfter) {
      res.setHeader('Retry-After', retryAfter);
      throw new ApplicationError(429, 'TOO_MANY_REQUESTS', 'Quá nhiều lần đăng nhập. Vui lòng thử lại sau');
    }
    return this.respond(await this.auth.login(phone, dto.password), res);
  }

  @Public() @UseGuards(AuthOriginGuard) @Post('refresh') @HttpCode(200)
  @ApiBody({ schema: { type: 'object', additionalProperties: false, maxProperties: 0 } })
  @ApiOkResponse({ type: AuthResponseDto })
  async refresh(@Body() body: Record<string, unknown>, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    if (Object.keys(body).length) throw new ApplicationError(400, 'VALIDATION_ERROR', 'Refresh body phải là object rỗng');
    const cookies: unknown = req.cookies;
    const token = cookies && typeof cookies === 'object' && 'gym_refresh' in cookies ? cookies.gym_refresh : undefined;
    return this.respond(await this.auth.refresh(token), res);
  }

  @Get('me') @ApiBearerAuth() @ApiOkResponse({ type: PrincipalDto })
  me(@CurrentUser() user: AuthPrincipal) { return user; }
}
