// Tầng API (US-28 bước 3): POST /api/me/pt-bookings – Member đặt một slot PT bằng gói của chính mình.
// Biết ai gọi qua JwtAuthGuard toàn cục; chỉ MEMBER (ptBookings.createOwn); member lấy từ phiên, không nhận memberId từ client.
import { Body, Controller, Post, Res } from '@nestjs/common';
import { Response } from 'express';
import { IdempotencyKey } from '../../common/decorators/idempotency-key.decorator';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { FixedPermission } from '../users/access.policy';
import { CreatePtBookingDto } from './booking.dto';
import { BookingService } from './booking.service';

@Controller('me')
export class BookingController {
  constructor(private readonly bookings: BookingService) {}

  // US-28-TC01, US-28-TC02 (sai role → 403), US-28-TC10 (gửi lại cùng key trả đúng 201 và body gốc).
  // passthrough: tự đặt mã HTTP đã lưu nhưng vẫn để Nest gửi body.
  @Post('pt-bookings')
  @FixedPermission('ptBookings.createOwn')
  async create(@CurrentUser() user: AuthPrincipal, @IdempotencyKey() key: string, @Body() dto: CreatePtBookingDto,
    @Res({ passthrough: true }) response: Response) {
    const result = await this.bookings.create(user.id, dto, key);
    response.status(result.status);
    return result.body;
  }
}
