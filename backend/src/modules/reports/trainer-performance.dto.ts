import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsMongoId, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { queryInteger } from '../../common/utils/query-integer';

export class TrainerPerformanceRangeDto {
  @ApiPropertyOptional({ format: 'date', description: 'Ngày VN, mặc định đầu tháng hiện tại' })
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) fromDate?: string;
  @ApiPropertyOptional({ format: 'date', description: 'Bao gồm cả ngày, tối đa hôm nay VN; kỳ tối đa 366 ngày' })
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) toDate?: string;
  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @Transform(queryInteger) @IsInt() @Min(1) @Max(100) limit = 20;
}
export class TrainerPerformanceListDto extends TrainerPerformanceRangeDto {
  @ApiPropertyOptional() @IsOptional() @IsMongoId() trainerId?: string;
  @ApiPropertyOptional({ maxLength: 120, description: 'Tìm literal tên hoặc ID PT' })
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsOptional() @IsString() @MaxLength(120) q?: string;
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @Transform(queryInteger) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) page = 1;
}
export class TrainerPerformanceDetailDto extends TrainerPerformanceRangeDto {
  @ApiPropertyOptional({ default: 1 }) @Transform(queryInteger) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) shiftPage = 1;
  @ApiPropertyOptional({ default: 1 }) @Transform(queryInteger) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) attendancePage = 1;
  @ApiPropertyOptional({ default: 1 }) @Transform(queryInteger) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) bookingPage = 1;
  @ApiPropertyOptional({ default: 1 }) @Transform(queryInteger) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) reviewPage = 1;
}
export class TrainerPerformanceIdDto {
  @ApiProperty() @IsMongoId() id!: string;
}
