// Tầng kiểm tra dữ liệu (US-30 bước 1): query của GET /api/me/trainees – PT tra cứu học viên của mình.
// Chỉ nhận q, hasUpcoming, page, limit; field lạ như trainerId, memberId → 400 (forbidNonWhitelisted, US-30-TC03).
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

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
