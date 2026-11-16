import { Type, Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsIn, IsInt, IsMongoId, IsString, Length, Max, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';
import { queryInteger } from '../../common/utils/query-integer';

const optional = (_: unknown, value: unknown) => value !== undefined;
const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;
export class RetailOrderItemDto {
  @ApiProperty() @IsMongoId() productId!: string;
  @ApiProperty({ minimum: 1, maximum: 999 }) @IsInt() @Min(1) @Max(999) quantity!: number;
}
export class PosPreviewDto {
  @ApiPropertyOptional() @ValidateIf(optional) @IsMongoId() memberId?: string;
  @ApiPropertyOptional() @ValidateIf(optional) @Transform(trim) @IsString() @Length(2, 120) buyerName?: string;
  @ApiPropertyOptional() @ValidateIf(optional) @Transform(trim) @IsString() @Length(8, 30) recipientPhone?: string;
  @ApiProperty({ enum: ['CASH', 'TRANSFER'] }) @IsIn(['CASH', 'TRANSFER']) preferredPaymentMethod!: 'CASH' | 'TRANSFER';
  @ApiProperty({ type: [RetailOrderItemDto] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100)
  @ArrayUnique((item: RetailOrderItemDto) => typeof item?.productId === 'string' ? item.productId.toLowerCase() : item?.productId)
  @ValidateNested({ each: true }) @Type(() => RetailOrderItemDto) items!: RetailOrderItemDto[];
}
export class PosCreateDto extends PosPreviewDto {
  @ApiProperty() @IsString() @Length(1, 50000) quoteToken!: string;
}
export class PosProductQueryDto {
  @ApiPropertyOptional() @ValidateIf(optional) @Transform(trim) @IsString() @MaxLength(120) q?: string;
  @ApiPropertyOptional() @ValidateIf(optional) @IsMongoId() categoryId?: string;
  @ApiPropertyOptional() @Transform(queryInteger) @IsInt() @Min(1) @Max(1000000) page = 1;
  @ApiPropertyOptional() @Transform(queryInteger) @IsInt() @Min(1) @Max(100) limit = 20;
}
