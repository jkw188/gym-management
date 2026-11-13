// Tầng kiểm tra dữ liệu (US-17): query của GET /api/me/memberships và /api/me/service-sales.
// ValidationPipe toàn cục bật forbidNonWhitelisted nên memberId, accountId hay field lạ đều bị 400 (US-17-TC02).
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { MEMBERSHIP_KINDS, MembershipKind, TIME_STATES, TimeState } from './me-memberships.types';
import { MembershipStatus } from './schemas/membership.schema';

const STORED_STATUSES: MembershipStatus[] = ['ACTIVE', 'SUPERSEDED', 'CANCELLED'];

// Query luôn là chuỗi: chỉ đổi sang số khi là số nguyên dương viết đúng dạng; "1.5", "abc", "0" giữ nguyên để @IsInt/@Min báo lỗi.
function queryInteger({ value }: { value: unknown }): unknown {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;
}

export class MeListQueryDto {
  // Spec US-17 mục 2: page mặc định 1.
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @Transform(queryInteger) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) page = 1;

  // Spec US-17 mục 2: limit mặc định 20, tối đa 100.
  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @Transform(queryInteger) @IsInt() @Min(1) @Max(100) limit = 20;
}

// Spec US-17 mục 2: GET /api/me/memberships nhận thêm kind?, storedStatus?, timeState? (giá trị ngoài enum → 400).
export class MeMembershipsQueryDto extends MeListQueryDto {
  @ApiPropertyOptional({ enum: MEMBERSHIP_KINDS })
  @IsOptional() @IsIn(MEMBERSHIP_KINDS) kind?: MembershipKind;

  // US-17-F02: lọc theo trạng thái lưu trong DB.
  @ApiPropertyOptional({ enum: STORED_STATUSES })
  @IsOptional() @IsIn(STORED_STATUSES) storedStatus?: MembershipStatus;

  // US-17-F02: lọc theo ngày Việt Nam so với kỳ gói.
  @ApiPropertyOptional({ enum: TIME_STATES })
  @IsOptional() @IsIn(TIME_STATES) timeState?: TimeState;
}
