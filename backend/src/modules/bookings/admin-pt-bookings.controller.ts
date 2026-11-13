// Tầng API (US-64 bước 3): Admin xử lý sai xác nhận buổi PT và xem chi tiết kèm lịch sử hoàn tất.
// POST /api/admin/pt-bookings/:id/corrections và GET /api/admin/pt-bookings/:id – chỉ ADMIN (ptBookings.correct); vai trò khác → 403.
import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { IdempotencyKey } from '../../common/decorators/idempotency-key.decorator';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { FixedPermission } from '../users/access.policy';
import { CorrectPtBookingDto, PtBookingIdParamDto } from './booking.dto';
import { CorrectBookingService } from './correct-booking.service';
import { SupportPtBookingsService } from './support-pt-bookings.service';

@Controller('admin/pt-bookings')
export class AdminPtBookingsController {
  constructor(
    private readonly corrections: CorrectBookingService,
    private readonly support: SupportPtBookingsService,
  ) {}

  // US-64-TC10, TC11, TC12, TC14: COMPLETE hỗ trợ hoặc REOPEN có lý do; trả 200.
  @Post(':id/corrections')
  @HttpCode(200)
  @FixedPermission('ptBookings.correct')
  correct(@CurrentUser() user: AuthPrincipal, @Param() params: PtBookingIdParamDto, @IdempotencyKey() key: string,
    @Body() dto: CorrectPtBookingDto) {
    return this.corrections.correct({
      actorId: user.id, bookingId: params.id, version: dto.version, action: dto.action, reason: dto.reason, idempotencyKey: key,
    });
  }

  // US-64-C04: chi tiết có nguồn quota và lịch sử COMPLETE/REOPEN.
  @Get(':id')
  @FixedPermission('ptBookings.correct')
  detail(@Param() params: PtBookingIdParamDto) {
    return this.support.adminDetail(params.id);
  }
}
