// Tầng kiểm tra dữ liệu (US-24 bước 1–2, US-25 bước 2): body của POST/PATCH, confirm/cancel và query của GET /api/me/work-shifts.
// Chỉ kiểm kiểu cơ bản; luật thời gian (offset, 60 phút, nửa đêm, khoảng 31 ngày…) nằm ở ShiftIntervalService.
// ValidationPipe toàn cục bật forbidNonWhitelisted nên trainerId, status, createdBy gửi lên đều bị 400 (US-24-F01).
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { SHIFT_STATUSES, ShiftStatus } from './shifts.types';

export class CreateShiftDto {
  // Chuỗi ISO 8601 có Z hoặc offset, ví dụ 2026-12-01T08:10:00+07:00.
  @ApiProperty({ example: '2026-12-01T08:10:00+07:00' })
  @IsString() startAt!: string;

  @ApiProperty({ example: '2026-12-01T10:40:00+07:00' })
  @IsString() endAt!: string;

  @ApiProperty({ example: 'Phòng PT 1', maxLength: 120 })
  @IsString() location!: string;
}

// PATCH gửi DTO đầy đủ kèm version đang xem để kiểm CAS (US-24-F04).
export class UpdateShiftDto extends CreateShiftDto {
  @ApiProperty({ example: 0, minimum: 0 })
  @IsInt() @Min(0) version!: number;
}

// Query luôn là chuỗi: chỉ đổi sang số khi là số nguyên dương viết đúng dạng; "1.5", "abc", "0" giữ nguyên để @IsInt/@Min báo lỗi.
function queryInteger({ value }: { value: unknown }): unknown {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;
}

// Ngày Việt Nam dạng YYYY-MM-DD; ngày có thật hay không và khoảng tối đa 31 ngày do service kiểm.
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export class ShiftListQueryDto {
  // Không gửi thì mặc định tuần hiện tại, bắt đầu từ thứ Hai.
  @ApiPropertyOptional({ example: '2026-12-01' })
  @IsOptional() @Matches(DATE_ONLY, { message: 'fromDate phải có dạng YYYY-MM-DD' }) fromDate?: string;

  @ApiPropertyOptional({ example: '2026-12-07' })
  @IsOptional() @Matches(DATE_ONLY, { message: 'toDate phải có dạng YYYY-MM-DD' }) toDate?: string;

  @ApiPropertyOptional({ enum: SHIFT_STATUSES })
  @IsOptional() @IsIn(SHIFT_STATUSES) status?: ShiftStatus;

  // Phân trang chung: page ≥ 1 mặc định 1; limit 1–100 mặc định 20.
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @Transform(queryInteger) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) page = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @Transform(queryInteger) @IsInt() @Min(1) @Max(100) limit = 20;
}

// POST /:id/confirm (US-25): chỉ gửi version đang xem để kiểm CAS.
export class ConfirmShiftDto {
  @ApiProperty({ example: 0, minimum: 0 })
  @IsInt() @Min(0) version!: number;
}

// POST /:id/cancel (US-25): version đang xem và lý do hủy.
// Chỉ kiểm là chuỗi; luật trim 10–500 ký tự nằm ở ShiftTransitionService.normalizeReason.
export class CancelShiftDto {
  @ApiProperty({ example: 0, minimum: 0 })
  @IsInt() @Min(0) version!: number;

  @ApiProperty({ example: 'PT bận việc gia đình', minLength: 10, maxLength: 500 })
  @IsString() reason!: string;
}
