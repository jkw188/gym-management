// Tầng API: quên mật khẩu US-05. Route công khai (không cần đăng nhập), nhận dữ liệu và gọi PasswordResetService.
import { Body, Controller, HttpCode, Post, Req, Res, UseFilters, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiAcceptedResponse, ApiOkResponse, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { ErrorResponseDto } from '../../common/http/error.dto';
import { refreshCookieOptions } from './auth.controller';
import { Public } from './auth.decorators';
import { AuthOriginGuard } from './auth.guards';
import { PasswordErrorFilter } from './password-error.filter';
import {
  PasswordResetConfirmDto, PasswordResetConfirmResponseDto, PasswordResetRequestDto, PasswordResetRequestResponseDto,
} from './password-reset.dto';
import { PasswordResetService } from './password-reset.service';

@ApiTags('auth')
@ApiResponse({ status: 400, type: ErrorResponseDto })
@ApiResponse({ status: 429, type: ErrorResponseDto, headers: { 'Retry-After': { schema: { type: 'integer' } } } })
@ApiResponse({ status: 503, type: ErrorResponseDto })
@Controller('auth/password-reset')
@UseFilters(PasswordErrorFilter)
export class PasswordResetController {
  constructor(private readonly passwordReset: PasswordResetService, private readonly config: ConfigService) {}

  // US-05-F03: luôn 202 cùng message và challenge, dù account có đủ điều kiện hay không. Header no-store do configureHttp đặt.
  @Public() @UseGuards(AuthOriginGuard) @Post('request') @HttpCode(202)
  @ApiAcceptedResponse({ type: PasswordResetRequestResponseDto })
  request(@Body() dto: PasswordResetRequestDto, @Req() req: Request) {
    return this.passwordReset.request(dto.identifier, dto.challenge, clientIp(req));
  }

  // US-05-F06: OTP đúng thì 200, không trả token hay cookie phiên mới.
  @Public() @UseGuards(AuthOriginGuard) @Post('confirm') @HttpCode(200)
  @ApiOkResponse({ type: PasswordResetConfirmResponseDto })
  async confirm(@Body() dto: PasswordResetConfirmDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.passwordReset.confirm(dto.challenge, dto.otp, dto.newPassword, clientIp(req));

    // US-05-TC12: chỉ xóa cookie gym_refresh khi đặt lại thành công, cùng flags và path của US-02 (giống US-67).
    const nodeEnv = this.config.getOrThrow<string>('nodeEnv');
    const frontendOrigin = this.config.getOrThrow<string>('frontendOrigin');
    res.clearCookie('gym_refresh', refreshCookieOptions(nodeEnv, frontendOrigin));
    return result;
  }
}

function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}
