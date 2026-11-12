// Tầng API (US-64 bước 2): POST /api/me/pt-bookings/:id/complete – PT xác nhận buổi mình đã dạy (ptBookings.completeOwn).
// Người gọi lấy từ phiên đăng nhập (JwtAuthGuard toàn cục); FixedPermission chặn Member/Staff/Admin bằng 403 trước khi vào service.
import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { IdempotencyKey } from '../../common/decorators/idempotency-key.decorator';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { FixedPermission } from '../users/access.policy';
import { CompletePtBookingDto, PtBookingIdParamDto } from './booking.dto';
import { CompleteBookingService } from './complete-booking.service';

@Controller()
export class PtBookingCompleteController {
  constructor(private readonly completions: CompleteBookingService) {}

  // US-64-TC01–TC09: trả 200 (lệnh không tạo tài nguyên mới; Nest mặc định POST là 201).
  @Post('me/pt-bookings/:id/complete')
  @HttpCode(200)
  @FixedPermission('ptBookings.completeOwn')
  complete(@CurrentUser() user: AuthPrincipal, @Param() params: PtBookingIdParamDto, @IdempotencyKey() key: string,
    @Body() dto: CompletePtBookingDto) {
    return this.completions.complete({ actorId: user.id, bookingId: params.id, version: dto.version, idempotencyKey: key });
  }
}
