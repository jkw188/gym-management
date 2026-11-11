// Tầng kiểm tra dữ liệu (US-29 bước 3): query của GET /api/pt-bookings – Staff/Admin tra cứu lịch PT để hỗ trợ.
// ValidationPipe toàn cục bật forbidNonWhitelisted nên field lạ → 400. Ngày có thật và khoảng ≤ 31 ngày do ShiftIntervalService kiểm.
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, Matches } from 'class-validator';
import { MeListQueryDto } from '../memberships/me-memberships.dto';
import { PT_BOOKING_STATUSES, PtBookingStatus } from './schemas/pt-booking.schema';

// Ngày Việt Nam dạng YYYY-MM-DD.
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const OBJECT_ID = /^[0-9a-f]{24}$/i;

// page/limit kế thừa khuôn chung (mặc định 1 và 20, tối đa 100 – US-29-TC05).
export class SupportPtBookingsQueryDto extends MeListQueryDto {
  // Không gửi thì mặc định tuần hiện tại từ thứ Hai (quy ước US-27).
  @ApiPropertyOptional({ example: '2026-12-01' })
  @IsOptional() @Matches(DATE_ONLY, { message: 'fromDate phải có dạng YYYY-MM-DD' }) fromDate?: string;

  @ApiPropertyOptional({ example: '2026-12-07' })
  @IsOptional() @Matches(DATE_ONLY, { message: 'toDate phải có dạng YYYY-MM-DD' }) toDate?: string;

  @ApiPropertyOptional({ example: '6730a1b2c3d4e5f601234567' })
  @IsOptional() @Matches(OBJECT_ID, { message: 'memberId không hợp lệ' }) memberId?: string;

  @ApiPropertyOptional({ example: '6730a1b2c3d4e5f601234568' })
  @IsOptional() @Matches(OBJECT_ID, { message: 'trainerId không hợp lệ' }) trainerId?: string;

  @ApiPropertyOptional({ enum: PT_BOOKING_STATUSES })
  @IsOptional() @IsIn(PT_BOOKING_STATUSES) status?: PtBookingStatus;
}
