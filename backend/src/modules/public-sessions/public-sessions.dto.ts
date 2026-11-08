// Tầng kiểm tra dữ liệu (US-26 bước 1): query của GET /api/public-sessions.
// ValidationPipe toàn cục bật forbidNonWhitelisted nên status, includeDrafts… gửi lên đều bị 400 (US-26-TC07).
// Ngày có thật và khoảng tối đa 31 ngày do ShiftIntervalService.vietnamDateRange kiểm.
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsMongoId, IsOptional, Matches, Max, Min } from 'class-validator';
import { SUBJECT_CODES, SubjectCode } from './public-sessions.types';

// Query luôn là chuỗi: chỉ đổi sang số khi là số nguyên dương viết đúng dạng; "0", "1.5", "abc" giữ nguyên để @IsInt/@Min báo lỗi.
function queryInteger({ value }: { value: unknown }): unknown {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;
}

// Ngày Việt Nam dạng YYYY-MM-DD.
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export class PublicSessionQueryDto {
  // Không gửi thì mặc định tuần hiện tại từ thứ Hai (US-26-F01).
  @ApiPropertyOptional({ example: '2026-12-01' })
  @IsOptional() @Matches(DATE_ONLY, { message: 'fromDate phải có dạng YYYY-MM-DD' }) fromDate?: string;

  @ApiPropertyOptional({ example: '2026-12-07' })
  @IsOptional() @Matches(DATE_ONLY, { message: 'toDate phải có dạng YYYY-MM-DD' }) toDate?: string;

  // US-26-TC07: chỉ nhận đúng mã taxonomy (viết hoa); mã lạ → 400, không tự đổi về "tất cả".
  @ApiPropertyOptional({ enum: SUBJECT_CODES })
  @IsOptional() @IsIn(SUBJECT_CODES) subjectCode?: SubjectCode;

  @ApiPropertyOptional({ example: '6650f0c2a1b2c3d4e5f60718' })
  @IsOptional() @IsMongoId({ message: 'trainerId không hợp lệ' }) trainerId?: string;

  // Phân trang chung: page ≥ 1 mặc định 1; limit 1–100 mặc định 20.
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @Transform(queryInteger) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) page = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @Transform(queryInteger) @IsInt() @Min(1) @Max(100) limit = 20;
}
