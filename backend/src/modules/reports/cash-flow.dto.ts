import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsMongoId, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { queryInteger } from '../../common/utils/query-integer';

export class CashFlowQueryDto {
  @ApiPropertyOptional({ format: 'date', description: 'Ngày VN, mặc định đầu tháng hiện tại' })
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) fromDate?: string;
  @ApiPropertyOptional({ format: 'date', description: 'Ngày VN bao gồm cả ngày; tối đa hôm nay và kỳ tối đa 366 ngày' })
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) toDate?: string;
  @ApiPropertyOptional({ enum: ['ALL', 'GYM', 'PT', 'RETAIL'], default: 'ALL' })
  @IsIn(['ALL', 'GYM', 'PT', 'RETAIL']) kind: 'ALL' | 'GYM' | 'PT' | 'RETAIL' = 'ALL';
  @ApiPropertyOptional({ enum: ['ALL', 'CASH', 'TRANSFER'], description: 'Chỉ lọc khoản thu', default: 'ALL' })
  @IsIn(['ALL', 'CASH', 'TRANSFER']) paymentMethod: 'ALL' | 'CASH' | 'TRANSFER' = 'ALL';
  @ApiPropertyOptional({ enum: ['ALL', 'CASH', 'TRANSFER'], description: 'Chỉ lọc khoản đã chi; không lọc nghĩa vụ hiện tại', default: 'ALL' })
  @IsIn(['ALL', 'CASH', 'TRANSFER']) payoutMethod: 'ALL' | 'CASH' | 'TRANSFER' = 'ALL';
}
export class CashFlowEventsQueryDto extends CashFlowQueryDto {
  @ApiPropertyOptional({ enum: ['ALL', 'RECEIPT', 'REFUND'], default: 'ALL' })
  @IsIn(['ALL', 'RECEIPT', 'REFUND']) eventType: 'ALL' | 'RECEIPT' | 'REFUND' = 'ALL';
  @ApiPropertyOptional({ maxLength: 120, description: 'Tìm literal mã/ID nguồn, chỉ lọc bảng sự kiện' })
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsOptional() @IsString() @MaxLength(120) q?: string;
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @Transform(queryInteger) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) page = 1;
  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @Transform(queryInteger) @IsInt() @Min(1) @Max(100) limit = 20;
}
export class CashFlowEventParamsDto {
  @ApiProperty({ enum: ['RECEIPT', 'REFUND'] }) @IsIn(['RECEIPT', 'REFUND']) eventType!: 'RECEIPT' | 'REFUND';
  @ApiProperty() @IsMongoId() id!: string;
}
