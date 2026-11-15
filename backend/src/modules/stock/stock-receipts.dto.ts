import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsMongoId, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested } from 'class-validator';
import { queryInteger } from '../../common/utils/query-integer';

const optional = (_: unknown, value: unknown) => value !== undefined;
const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;
export class EmptyStockQueryDto {}
export class ReceiptItemDto {
  @ApiProperty() @IsMongoId() productId!: string;
  @ApiProperty({ minimum: 1, maximum: 1000000 }) @IsInt() @Min(1) @Max(1000000) quantity!: number;
  @ApiProperty({ example: '5000', pattern: '^\\d{1,12}$' }) @IsString() @Matches(/^\d{1,12}$/) unitCost!: string;
}
export class CreateReceiptDto {
  @ApiProperty({ minLength: 10, maxLength: 500 }) @Transform(trim) @IsString() @MinLength(10) @MaxLength(500) reason!: string;
  @ApiPropertyOptional({ maxLength: 100 }) @ValidateIf(optional) @Transform(trim) @IsString() @MaxLength(100) sourceReference?: string;
  @ApiProperty({ type: [ReceiptItemDto], minItems: 1, maxItems: 100 })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => ReceiptItemDto) items!: ReceiptItemDto[];
}
export class UpdateReceiptDto extends CreateReceiptDto {
  @ApiProperty({ minimum: 0, maximum: 2147483647 }) @IsInt() @Min(0) @Max(2147483647) version!: number;
}
export class PostReceiptDto {
  @ApiProperty({ minimum: 0, maximum: 2147483647 }) @IsInt() @Min(0) @Max(2147483647) version!: number;
}
export class StockPageQueryDto {
  @ApiPropertyOptional({ maxLength: 120 }) @ValidateIf(optional) @Transform(trim) @IsString() @MaxLength(120) q?: string;
  @ApiPropertyOptional({ default: 1 }) @Transform(queryInteger) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) page = 1;
  @ApiPropertyOptional({ default: 20, maximum: 100 }) @Transform(queryInteger) @IsInt() @Min(1) @Max(100) limit = 20;
}
export class ReceiptQueryDto extends StockPageQueryDto {
  @ApiPropertyOptional({ enum: ['DRAFT', 'POSTED'] }) @ValidateIf(optional) @IsIn(['DRAFT', 'POSTED']) status?: 'DRAFT' | 'POSTED';
  @ApiPropertyOptional() @ValidateIf(optional) @IsString() fromDate?: string;
  @ApiPropertyOptional() @ValidateIf(optional) @IsString() toDate?: string;
}
export class ProductOptionsQueryDto extends StockPageQueryDto {
  @ApiPropertyOptional() @ValidateIf(optional) @IsMongoId() categoryId?: string;
}

export class PostedReceiptResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() code!: string;
  @ApiProperty({ enum: ['POSTED'] }) status!: string;
  @ApiProperty() version!: number;
  @ApiProperty() postedAt!: string;
  @ApiProperty() postedBy!: string;
  @ApiProperty({ example: '50000' }) totalCost!: string;
  @ApiProperty({ type: [String] }) movementIds!: string[];
}
export class ReceiptItemResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() productId!: string;
  @ApiProperty() skuSnapshot!: string;
  @ApiProperty() nameSnapshot!: string;
  @ApiProperty() quantity!: number;
  @ApiProperty() unitCost!: string;
  @ApiProperty() lineTotalCost!: string;
  @ApiProperty() inactiveWarning!: boolean;
}
export class ReceiptResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() code!: string;
  @ApiProperty({ enum: ['DRAFT', 'POSTED'] }) status!: string;
  @ApiProperty() reason!: string;
  @ApiProperty({ nullable: true, type: String }) sourceReference!: string | null;
  @ApiProperty() version!: number;
  @ApiProperty() totalCost!: string;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
  @ApiProperty() createdBy!: string;
  @ApiProperty() updatedBy!: string;
  @ApiProperty({ nullable: true, type: String }) postedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) postedBy!: string | null;
  @ApiProperty({ type: [ReceiptItemResponseDto] }) items!: ReceiptItemResponseDto[];
  @ApiProperty({ type: [String] }) movementIds!: string[];
  @ApiProperty({ type: () => [ReceiptMovementResponseDto] }) movements!: ReceiptMovementResponseDto[];
}
export class ReceiptMovementResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() documentItemId!: string;
  @ApiProperty() productId!: string;
  @ApiProperty() sequence!: number;
  @ApiProperty() skuSnapshot!: string;
  @ApiProperty() nameSnapshot!: string;
  @ApiProperty() onHandDelta!: number;
  @ApiProperty() reservedDelta!: number;
  @ApiProperty() beforeOnHand!: number;
  @ApiProperty() beforeReserved!: number;
  @ApiProperty() afterOnHand!: number;
  @ApiProperty() afterReserved!: number;
  @ApiProperty() createdAt!: string;
  @ApiProperty() sourceId!: string;
  @ApiProperty() sourceCode!: string;
}
export class ReceiptSummaryResponseDto extends OmitType(ReceiptResponseDto, ['items', 'movementIds', 'movements'] as const) {}
export class StockPageResponseDto {
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
}
export class ReceiptPageResponseDto extends StockPageResponseDto {
  @ApiProperty({ type: [ReceiptSummaryResponseDto] }) items!: ReceiptSummaryResponseDto[];
}
export class ProductOptionResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() sku!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['ACTIVE', 'INACTIVE'] }) status!: string;
  @ApiProperty() effectiveActive!: boolean;
  @ApiProperty({ enum: ['VALID', 'MISSING', 'INCONSISTENT'] }) inventoryState!: string;
}
export class ProductOptionsPageResponseDto extends StockPageResponseDto {
  @ApiProperty({ type: [ProductOptionResponseDto] }) items!: ProductOptionResponseDto[];
}
