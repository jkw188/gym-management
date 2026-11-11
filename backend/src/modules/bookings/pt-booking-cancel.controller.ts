// Tầng API (US-29 bước 3): hai đường hủy buổi PT dùng CHUNG CancelBookingService.
// POST /api/me/pt-bookings/:id/cancel – Member tự hủy (ptBookings.cancelOwn); POST /api/pt-bookings/:id/cancel – Staff/Admin hủy hỗ trợ (ptBookings.cancelSupport).
// Người gọi lấy từ phiên đăng nhập (JwtAuthGuard toàn cục); FixedPermission chặn sai vai trò bằng 403 trước khi vào service.
import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { IdempotencyKey } from '../../common/decorators/idempotency-key.decorator';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { FixedPermission } from '../users/access.policy';
import { CancelPtBookingDto } from './booking.dto';
import { CancelBookingService } from './cancel-booking.service';

@Controller()
export class PtBookingCancelController {
  constructor(private readonly cancellations: CancelBookingService) {}

  // US-29-TC01, TC02, TC03, TC04, TC06, TC07, TC09, TC12: Member hủy buổi của chính mình, phải còn ≥ 2 giờ.
  // HttpCode(200): lệnh hủy không tạo tài nguyên mới nên trả 200 (Nest mặc định POST là 201).
  @Post('me/pt-bookings/:id/cancel')
  @HttpCode(200)
  @FixedPermission('ptBookings.cancelOwn')
  cancelOwn(@CurrentUser() user: AuthPrincipal, @Param('id') id: string, @IdempotencyKey() key: string, @Body() dto: CancelPtBookingDto) {
    return this.cancellations.cancel({
      policy: 'OWN', actorId: user.id, actorRole: user.roleCode, bookingId: id, version: dto.version, reason: dto.reason, idempotencyKey: key,
    });
  }

  // US-29-TC05, TC06, TC07, TC08, TC09, TC12: Staff/Admin hủy hỗ trợ có lý do, được hủy cả khi sát giờ hoặc đã qua giờ.
  @Post('pt-bookings/:id/cancel')
  @HttpCode(200)
  @FixedPermission('ptBookings.cancelSupport')
  cancelSupport(@CurrentUser() user: AuthPrincipal, @Param('id') id: string, @IdempotencyKey() key: string, @Body() dto: CancelPtBookingDto) {
    return this.cancellations.cancel({
      policy: 'SUPPORT', actorId: user.id, actorRole: user.roleCode, bookingId: id, version: dto.version, reason: dto.reason, idempotencyKey: key,
    });
  }
}
