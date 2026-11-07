import { Body, Controller, Get, HttpCode, Post, Query, Req, Res, UseFilters, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CookieOptions, Request, Response } from 'express';
import { ApplicationError } from '../../common/errors/application-error';
import { ErrorResponseDto } from '../../common/http/error.dto';
import { normalizePhone } from '../../common/utils/normalization';
import { CurrentUser, Public, Roles } from './auth.decorators';
import { AuthOriginGuard } from './auth.guards';
import { AuthService } from './auth.service';
import { extractAccessToken } from './jwt.strategy';
import { AuthPrincipal } from './auth.types';
import { ChangePasswordDto, ChangePasswordQueryDto, ChangePasswordResponseDto } from './change-password.dto';
import { PasswordErrorFilter } from './password-error.filter';
import { LoginLimiter } from './login-limiter.service';
import { AuthResponseDto, LoginDto, PrincipalDto } from './login.dto';
import { LOGOUT_BODY_SCHEMA } from './logout.dto';
import { RegisterDto, RegisterResponseDto } from './register.dto';
import { RegistrationGuard } from './registration.guard';
import { UsersService } from '../users/users.service';

export function refreshCookieOptions(nodeEnv: string, frontendOrigin: string, expiresAt?: Date): CookieOptions {
  const hostname = new URL(frontendOrigin).hostname;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
  const options: CookieOptions = { httpOnly: true, sameSite: 'lax', path: '/api/auth', secure: nodeEnv === 'production' || !local };
  if (expiresAt) {
    options.expires = expiresAt;
  }
  return options;
}

function refreshCookie(req: Request): unknown {
  const cookies: unknown = req.cookies;
  if (cookies && typeof cookies === 'object' && 'gym_refresh' in cookies) {
    return cookies.gym_refresh;
  }
  return undefined;
}

function requireEmptyBody(body: Record<string, unknown>, endpoint: string) {
  const fieldCount = Object.keys(body).length;
  if (fieldCount > 0) {
    throw new ApplicationError(400, 'VALIDATION_ERROR', `${endpoint} body phải là object rỗng`);
  }
}

@ApiTags('auth')
@ApiResponse({ status: 400, type: ErrorResponseDto })
@ApiResponse({ status: 401, type: ErrorResponseDto })
@ApiResponse({ status: 403, type: ErrorResponseDto })
@ApiResponse({ status: 503, type: ErrorResponseDto })
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly limiter: LoginLimiter, private readonly config: ConfigService,
    private readonly users: UsersService) {}

  @Public() @UseGuards(RegistrationGuard) @Post('register')
  @ApiCreatedResponse({ type: RegisterResponseDto })
  @ApiResponse({ status: 409, type: ErrorResponseDto, description: 'REGISTRATION_CONFLICT / REGISTRATION_NEEDS_HELP / ROLE_NOT_CONFIGURED' })
  @ApiResponse({ status: 429, type: ErrorResponseDto, headers: { 'Retry-After': { schema: { type: 'integer' } } } })
  register(@Body() dto: RegisterDto) { return this.users.register(dto); }

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
    requireEmptyBody(body, 'Refresh');
    return this.respond(await this.auth.refresh(refreshCookie(req)), res);
  }

  @Public() @UseGuards(AuthOriginGuard) @Post('logout') @HttpCode(204)
  @ApiBearerAuth() @ApiBody({ schema: LOGOUT_BODY_SCHEMA }) @ApiNoContentResponse()
  async logout(@Body() body: Record<string, unknown>, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    requireEmptyBody(body, 'Logout');

    const authorization = req.headers.authorization;
    const refreshToken = refreshCookie(req);
    await this.auth.logout(authorization, refreshToken);

    const nodeEnv = this.config.getOrThrow<string>('nodeEnv');
    const frontendOrigin = this.config.getOrThrow<string>('frontendOrigin');
    res.clearCookie('gym_refresh', refreshCookieOptions(nodeEnv, frontendOrigin));
  }

  @Post('change-password') @HttpCode(200) @Roles('MEMBER', 'TRAINER') @ApiBearerAuth()
  @UseFilters(PasswordErrorFilter) @ApiOkResponse({ type: ChangePasswordResponseDto })
  @ApiResponse({ status: 429, type: ErrorResponseDto, headers: { 'Retry-After': { schema: { type: 'integer' } } } })
  async changePassword(@CurrentUser() user: AuthPrincipal, @Body() dto: ChangePasswordDto, @Query() _query: ChangePasswordQueryDto,
    @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // _query không dùng trong thân hàm, chỉ khai báo để ValidationPipe từ chối mọi query.
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const result = await this.auth.changePassword(user, extractAccessToken(req), ip, dto.currentPassword, dto.newPassword);

    // US-67-TC13: chỉ xóa cookie sau khi đổi thành công, cùng flags và path của US-02.
    const nodeEnv = this.config.getOrThrow<string>('nodeEnv');
    const frontendOrigin = this.config.getOrThrow<string>('frontendOrigin');
    res.clearCookie('gym_refresh', refreshCookieOptions(nodeEnv, frontendOrigin));
    return result;
  }

  @Get('me') @ApiBearerAuth() @ApiOkResponse({ type: PrincipalDto })
  me(@CurrentUser() user: AuthPrincipal) { return user; }
}
