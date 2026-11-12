// Tầng kiểm tra dữ liệu (US-64 bước 4): query của GET /api/me/trainer-bookings – PT xem buổi dạy của mình.
// fromDate, toDate bắt buộc (ngày VN YYYY-MM-DD); status tùy chọn. Field lạ → 400 (forbidNonWhitelisted).
// Ngày có thật, toDate không trước fromDate và khoảng tối đa 31 ngày do ShiftIntervalService.vietnamDateRange kiểm.
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, Matches } from 'class-validator';
import { PT_BOOKING_STATUSES, PtBookingStatus } from './schemas/pt-booking.schema';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export class TrainerBookingsQueryDto {
  // US-64-TC15: thiếu hoặc sai định dạng → 400.
  @ApiProperty({ example: '2026-11-25' })
  @Matches(DATE_ONLY, { message: 'fromDate phải có dạng YYYY-MM-DD' }) fromDate!: string;

  @ApiProperty({ example: '2026-11-25' })
  @Matches(DATE_ONLY, { message: 'toDate phải có dạng YYYY-MM-DD' }) toDate!: string;

  // US-64-TC15: giá trị ngoài BOOKED/COMPLETED/CANCELLED → 400.
  @ApiPropertyOptional({ enum: PT_BOOKING_STATUSES })
  @IsOptional() @IsIn(PT_BOOKING_STATUSES) status?: PtBookingStatus;
}
