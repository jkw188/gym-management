import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsISO8601, IsIn, IsInt, IsMongoId, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { queryInteger } from '../../common/utils/query-integer';

export class MembershipReportTimeDto {
  @ApiPropertyOptional({ format: 'date-time', description: 'Timestamp có timezone, không sau observedAt; mặc định giờ server' })
  @IsOptional() @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/)
  asOfAt?: string;
}
export class MembershipSummaryQueryDto extends MembershipReportTimeDto {
  @ApiPropertyOptional({ enum: ['ALL', 'GYM', 'PT'], default: 'ALL' })
  @IsIn(['ALL', 'GYM', 'PT']) kind: 'ALL' | 'GYM' | 'PT' = 'ALL';
}
export class MembershipMembersQueryDto extends MembershipSummaryQueryDto {
  @ApiPropertyOptional({ enum: ['ALL', 'ACTIVE', 'INACTIVE'], default: 'ALL' })
  @IsIn(['ALL', 'ACTIVE', 'INACTIVE']) activity: 'ALL' | 'ACTIVE' | 'INACTIVE' = 'ALL';
  @ApiPropertyOptional({ maxLength: 120, description: 'Tìm literal theo mã hoặc tên; chỉ lọc bảng' })
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsOptional() @IsString() @MaxLength(120) q?: string;
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @Transform(queryInteger) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) page = 1;
  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @Transform(queryInteger) @IsInt() @Min(1) @Max(100) limit = 20;
}
export class MembershipReportIdDto { @ApiProperty() @IsMongoId() id!: string }
