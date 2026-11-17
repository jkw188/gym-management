import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsMongoId, IsOptional, Matches, Max, Min } from 'class-validator';
import { queryInteger } from '../../common/utils/query-integer';

class ActivityPeriodQueryDto {
  @ApiPropertyOptional({ example: '2026-11-01', description: 'Ngày VN; mặc định 30 ngày gần nhất, tối đa 366 ngày' })
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) fromDate?: string;
  @ApiPropertyOptional({ example: '2026-11-30' })
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) toDate?: string;
  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @Transform(queryInteger) @IsInt() @Min(1) @Max(100) limit = 20;
}
export class ActivityListQueryDto extends ActivityPeriodQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsMongoId() trainerId?: string;
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @Transform(queryInteger) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) page = 1;
}
export class ActivityDetailQueryDto extends ActivityPeriodQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @Transform(queryInteger) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) shiftPage = 1;
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @Transform(queryInteger) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) bookingPage = 1;
}
export class ActivityIdDto { @ApiProperty() @IsMongoId() id!: string }
export class EmptyActivityQueryDto {}
