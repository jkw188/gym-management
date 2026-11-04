// Tầng API: quên mật khẩu US-05. Route công khai (không cần đăng nhập), nhận dữ liệu và gọi PasswordResetService.
import { Body, Controller, HttpCode, Post, Req, UseFilters, UseGuards } from '@nestjs/common';
import { ApiAcceptedResponse, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { ErrorResponseDto } from '../../common/http/error.dto';
import { Public } from './auth.decorators';
import { AuthOriginGuard } from './auth.guards';
import { PasswordErrorFilter } from './password-error.filter';
import { PasswordResetRequestDto, PasswordResetRequestResponseDto } from './password-reset.dto';
import { PasswordResetService } from './password-reset.service';

@ApiTags('auth')
@ApiResponse({ status: 400, type: ErrorResponseDto })
@ApiResponse({ status: 503, type: ErrorResponseDto })
@Controller('auth/password-reset')
@UseFilters(PasswordErrorFilter)
export class PasswordResetController {
  constructor(private readonly passwordReset: PasswordResetService) {}

  // US-05-F03: luôn 202 cùng message và challenge, dù account có đủ điều kiện hay không. Header no-store do configureHttp đặt.
  @Public() @UseGuards(AuthOriginGuard) @Post('request') @HttpCode(202)
  @ApiAcceptedResponse({ type: PasswordResetRequestResponseDto })
  @ApiResponse({ status: 429, type: ErrorResponseDto, headers: { 'Retry-After': { schema: { type: 'integer' } } } })
  request(@Body() dto: PasswordResetRequestDto, @Req() req: Request) {
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    return this.passwordReset.request(dto.identifier, dto.challenge, ip);
  }
}
