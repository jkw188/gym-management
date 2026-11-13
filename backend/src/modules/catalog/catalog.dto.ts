// Tầng kiểm tra dữ liệu (US-13 bước 1): query của GET /api/catalog/plans.
// ValidationPipe toàn cục bật forbidNonWhitelisted nên filter lạ như status gửi lên đều bị 400 (US-13-F03).
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { PLAN_KINDS, PlanKind } from '../plans/schemas/plan.schema';

// Query luôn là chuỗi: chỉ đổi sang số khi là số nguyên dương viết đúng dạng; "0", "1.5", "abc" giữ nguyên để @IsInt/@Min báo lỗi.
function queryInteger({ value }: { value: unknown }): unknown {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;
}

// Giá VND là chuỗi số nguyên 0–999999999999 (EN-02), không âm, không lẻ, không exponent.
const VND_INTEGER = /^\d{1,12}$/;

export class CatalogPlanQueryDto {
  // Từ khóa tìm theo mã hoặc tên; service trim và tìm literal (US-13-TC08).
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional() @IsString() @MaxLength(120) q?: string;

  @ApiPropertyOptional({ enum: PLAN_KINDS })
  @IsOptional() @IsIn(PLAN_KINDS) kind?: PlanKind;

  @ApiPropertyOptional({ example: '500000' })
  @IsOptional() @Matches(VND_INTEGER, { message: 'minPrice phải là số nguyên VND' }) minPrice?: string;

  @ApiPropertyOptional({ example: '3000000' })
  @IsOptional() @Matches(VND_INTEGER, { message: 'maxPrice phải là số nguyên VND' }) maxPrice?: string;

  // Phân trang chung: page ≥ 1 mặc định 1; limit 1–100 mặc định 20.
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @Transform(queryInteger) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) page = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @Transform(queryInteger) @IsInt() @Min(1) @Max(100) limit = 20;
}
