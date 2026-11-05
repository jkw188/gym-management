// Tầng kiểm tra dữ liệu (US-47 bước 2): query của GET /api/me/notifications và body của POST /api/me/notifications/:id/read.
// ValidationPipe toàn cục bật forbidNonWhitelisted nên field ngoài danh sách (accountId, memberId, readAt…) đều bị 400.
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, Max, Min } from 'class-validator';
import { ReadState } from './notifications.types';

const READ_STATES: ReadState[] = ['ALL', 'UNREAD', 'READ'];

// Query luôn là chuỗi: chỉ đổi sang số khi là số nguyên dương viết đúng dạng; "1.5", "abc", "0" giữ nguyên để @IsInt/@Min báo lỗi.
function queryInteger({ value }: { value: unknown }): unknown {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;
}

export class InboxQueryDto {
  // US-47-TC08: chỉ ALL/UNREAD/READ, mặc định ALL.
  @ApiPropertyOptional({ enum: READ_STATES, default: 'ALL' })
  @IsIn(READ_STATES) readState: ReadState = 'ALL';

  // US-47-D02: page nguyên ≥ 1, mặc định 1. page lớn hơn totalPages vẫn hợp lệ.
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @Transform(queryInteger) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) page = 1;

  // US-47-D02: limit nguyên 1–100, mặc định 20.
  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @Transform(queryInteger) @IsInt() @Min(1) @Max(100) limit = 20;
}

// US-47-TC02: body của mark-read phải là {}; client tự gửi readAt hoặc accountId thì 400.
export class MarkReadDto {}
