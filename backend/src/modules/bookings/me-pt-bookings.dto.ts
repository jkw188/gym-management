// Tầng kiểm tra dữ liệu (US-27 bước 2): query của GET /api/me/pt-bookings.
// ValidationPipe toàn cục bật forbidNonWhitelisted nên memberId, accountId hay field lạ đều bị 400 (US-27-TC11).
// Ngày có thật và khoảng tối đa 31 ngày do ShiftIntervalService.vietnamDateRange kiểm.
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, Matches } from 'class-validator';
import { MeListQueryDto } from '../memberships/me-memberships.dto';
import { PT_BOOKING_STATUSES, PtBookingStatus } from './schemas/pt-booking.schema';

// Ngày Việt Nam dạng YYYY-MM-DD.
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// page/limit kế thừa khuôn chung (mặc định 1 và 20, tối đa 100).
export class MePtBookingsQueryDto extends MeListQueryDto {
  // Không gửi thì mặc định tuần hiện tại từ thứ Hai (spec mục 2).
  @ApiPropertyOptional({ example: '2026-12-01' })
  @IsOptional() @Matches(DATE_ONLY, { message: 'fromDate phải có dạng YYYY-MM-DD' }) fromDate?: string;

  @ApiPropertyOptional({ example: '2026-12-07' })
  @IsOptional() @Matches(DATE_ONLY, { message: 'toDate phải có dạng YYYY-MM-DD' }) toDate?: string;

  // US-27-TC10: lọc tùy chọn theo trạng thái; giá trị ngoài enum → 400.
  @ApiPropertyOptional({ enum: PT_BOOKING_STATUSES })
  @IsOptional() @IsIn(PT_BOOKING_STATUSES) status?: PtBookingStatus;
}
