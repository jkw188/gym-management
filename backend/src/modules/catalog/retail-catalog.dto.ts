import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsMongoId, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { queryInteger } from '../../common/utils/query-integer';
import { categoryName, RETAIL_STATUSES, RetailStatus, retailSku } from './retail-catalog.policy';

const optional = (_: unknown, value: unknown) => value !== undefined;
const nullable = (_: unknown, value: unknown) => value !== undefined && value !== null;
const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;
const name = ({ value }: { value: unknown }) => typeof value === 'string' ? categoryName(value) : value;

export class EmptyRetailQueryDto {}
export class RetailCategoryQueryDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @ValidateIf(optional) @Transform(trim) @IsString() @MaxLength(120) q?: string;
  @ApiPropertyOptional({ enum: RETAIL_STATUSES })
  @ValidateIf(optional) @IsIn(RETAIL_STATUSES) status?: RetailStatus;
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @Transform(queryInteger) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) page = 1;
  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @Transform(queryInteger) @IsInt() @Min(1) @Max(100) limit = 20;
}
export class RetailProductQueryDto extends RetailCategoryQueryDto {
  @ApiPropertyOptional()
  @ValidateIf(optional) @IsMongoId() categoryId?: string;
}
export class CreateRetailCategoryDto {
  @ApiProperty({ minLength: 1, maxLength: 120 })
  @Transform(name) @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @ApiProperty({ enum: RETAIL_STATUSES })
  @IsIn(RETAIL_STATUSES) status!: RetailStatus;
}
export class UpdateRetailCategoryDto {
  @ApiProperty({ minimum: 0, maximum: 2147483647 })
  @IsInt() @Min(0) @Max(2147483647) version!: number;
  @ApiPropertyOptional({ minLength: 1, maxLength: 120 })
  @ValidateIf(optional) @Transform(name) @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @ApiPropertyOptional({ enum: RETAIL_STATUSES })
  @ValidateIf(optional) @IsIn(RETAIL_STATUSES) status?: RetailStatus;
}
export class CreateRetailProductDto {
  @ApiProperty()
  @IsMongoId() categoryId!: string;
  @ApiProperty({ pattern: '^[A-Z0-9_-]{1,40}$', description: 'Trim, uppercase ASCII; bất biến sau tạo' })
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? retailSku(value) : value)
  @IsString() @Matches(/^[A-Z0-9_-]{1,40}$/) sku!: string;
  @ApiProperty({ minLength: 1, maxLength: 120 })
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @ValidateIf(nullable) @Transform(trim) @IsString() @MaxLength(2000) description?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 500, description: 'HTTPS; rỗng/null để xóa' })
  @ValidateIf(nullable) @Transform(trim) @IsString() @MaxLength(500) imageUrl?: string | null;
  @ApiProperty({ example: '5000', pattern: '^\\d{1,12}$' })
  @IsString() @Matches(/^\d{1,12}$/) price!: string;
  @ApiProperty({ enum: RETAIL_STATUSES })
  @IsIn(RETAIL_STATUSES) status!: RetailStatus;
}
export class UpdateRetailProductDto {
  @ApiProperty({ minimum: 0, maximum: 2147483647 })
  @IsInt() @Min(0) @Max(2147483647) version!: number;
  @ApiPropertyOptional()
  @ValidateIf(optional) @IsMongoId() categoryId?: string;
  @ApiPropertyOptional({ minLength: 1, maxLength: 120 })
  @ValidateIf(optional) @Transform(trim) @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @ValidateIf(nullable) @Transform(trim) @IsString() @MaxLength(2000) description?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 500 })
  @ValidateIf(nullable) @Transform(trim) @IsString() @MaxLength(500) imageUrl?: string | null;
  @ApiPropertyOptional({ example: '5000', pattern: '^\\d{1,12}$' })
  @ValidateIf(optional) @IsString() @Matches(/^\d{1,12}$/) price?: string;
  @ApiPropertyOptional({ enum: RETAIL_STATUSES })
  @ValidateIf(optional) @IsIn(RETAIL_STATUSES) status?: RetailStatus;
}

export class RetailEntityResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: RETAIL_STATUSES }) status!: RetailStatus;
  @ApiProperty() version!: number;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}
export class RetailCategoryResponseDto extends RetailEntityResponseDto {
  @ApiProperty() affectedActiveProductCount!: number;
}
export class RetailProductResponseDto extends RetailEntityResponseDto {
  @ApiProperty() categoryId!: string;
  @ApiProperty() categoryName!: string;
  @ApiProperty({ enum: RETAIL_STATUSES }) categoryStatus!: RetailStatus;
  @ApiProperty() sku!: string;
  @ApiProperty({ type: String, nullable: true }) description!: string | null;
  @ApiProperty({ type: String, nullable: true }) imageUrl!: string | null;
  @ApiProperty({ example: '5000' }) price!: string;
  @ApiProperty() effectiveActive!: boolean;
}
export class RetailPageResponseDto {
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
}
export class RetailCategoryPageDto extends RetailPageResponseDto {
  @ApiProperty({ type: [RetailCategoryResponseDto] }) items!: RetailCategoryResponseDto[];
}
export class RetailProductPageDto extends RetailPageResponseDto {
  @ApiProperty({ type: [RetailProductResponseDto] }) items!: RetailProductResponseDto[];
}
