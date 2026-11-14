// Tầng kiểm tra dữ liệu (US-30 bước 1–2): query của GET /api/me/trainees và các API con /:memberId/bookings, /:memberId/memberships.
// Chỉ nhận field trong allowlist; field lạ như trainerId, memberId → 400 (forbidNonWhitelisted, US-30-TC03).
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { PT_BOOKING_STATUSES, PtBookingStatus } from '../bookings/schemas/pt-booking.schema';
import { MeListQueryDto } from '../memberships/me-memberships.dto';

// Ngày Việt Nam dạng YYYY-MM-DD.
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// Query luôn là chuỗi: '12' → 12; '0', 'abc' giữ nguyên để @IsInt/@Min báo 400.
const toPositiveInteger = ({ value }: { value: unknown }) => (typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value);
// 'true' → true, 'false' → false; giá trị khác giữ nguyên để @IsBoolean báo 400.
const toBoolean = ({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value);
// US-30-TC08: bỏ khoảng trắng hai đầu trước khi kiểm độ dài.
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class TraineesQueryDto {
  // US-30-TC08: tìm theo tên hoặc mã hội viên, tối đa 120 ký tự sau khi trim.
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional() @Transform(trim) @IsString() @MaxLength(120) q?: string;

  // US-30-TC01: true = chỉ học viên còn buổi BOOKED sắp tới; false = phần còn lại.
  @ApiPropertyOptional({ type: Boolean })
  @IsOptional() @Transform(toBoolean) @IsBoolean() hasUpcoming?: boolean;

  // US-30-TC01: page mặc định 1; limit mặc định 20, tối đa 100.
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @Transform(toPositiveInteger) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) page = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @Transform(toPositiveInteger) @IsInt() @Min(1) @Max(100) limit = 20;
}

// US-30 bước 2 – GET /api/me/trainees/:memberId/bookings. page/limit kế thừa khuôn chung (mặc định 1 và 20, tối đa 100).
// Ngày có thật, toDate không trước fromDate, tối đa 31 ngày và mặc định tuần hiện tại do ShiftIntervalService.vietnamDateRange kiểm.
export class TraineeBookingsQueryDto extends MeListQueryDto {
  // US-30-TC05: không gửi thì mặc định tuần hiện tại từ thứ Hai.
  @ApiPropertyOptional({ example: '2026-11-09' })
  @IsOptional() @Matches(DATE_ONLY, { message: 'fromDate phải có dạng YYYY-MM-DD' }) fromDate?: string;

  @ApiPropertyOptional({ example: '2026-11-15' })
  @IsOptional() @Matches(DATE_ONLY, { message: 'toDate phải có dạng YYYY-MM-DD' }) toDate?: string;

  // US-30-TC05: lọc tùy chọn theo trạng thái; giá trị ngoài BOOKED/COMPLETED/CANCELLED → 400.
  @ApiPropertyOptional({ enum: PT_BOOKING_STATUSES })
  @IsOptional() @IsIn(PT_BOOKING_STATUSES) status?: PtBookingStatus;
}

// US-30 bước 2 – GET /api/me/trainees/:memberId/memberships: chỉ phân trang.
export class TraineeMembershipsQueryDto extends MeListQueryDto {}
