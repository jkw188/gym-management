// Tầng kiểm tra dữ liệu (US-35 bước 1): query của GET /api/categories, /api/products, /api/products/:id.
// ValidationPipe toàn cục bật forbidNonWhitelisted nên query ngoài allowlist (status, unitCost…) đều bị 400 (US-35-TC02).
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsMongoId, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { queryInteger } from '../../common/utils/query-integer';
import { PRODUCT_SORTS, ProductSort } from './products.types';

// Giá VND là chuỗi số nguyên 0–999999999999: không âm, không phần lẻ, không exponent, không dấu phân cách (US-35-TC07).
const VND_INTEGER = /^\d{1,12}$/;

// Bỏ khoảng trắng đầu/cuối của từ khóa trước khi kiểm độ dài 120 ký tự.
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class PublicCategoryQueryDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional() @Transform(trim) @IsString() @MaxLength(120) q?: string;

  // Phân trang chung: page ≥ 1 mặc định 1; limit 1–100 mặc định 20.
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @Transform(queryInteger) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) page = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @Transform(queryInteger) @IsInt() @Min(1) @Max(100) limit = 20;
}

export class PublicProductQueryDto extends PublicCategoryQueryDto {
  // US-35-TC07: ObjectId sai cú pháp → 400.
  @ApiPropertyOptional()
  @IsOptional() @IsMongoId() categoryId?: string;

  @ApiPropertyOptional({ example: '10000' })
  @IsOptional() @Matches(VND_INTEGER, { message: 'minPrice phải là số nguyên VND' }) minPrice?: string;

  @ApiPropertyOptional({ example: '50000' })
  @IsOptional() @Matches(VND_INTEGER, { message: 'maxPrice phải là số nguyên VND' }) maxPrice?: string;

  // Chỉ nhận 3 cách sắp; không cho client sắp theo field tùy ý (US-35-TC07).
  @ApiPropertyOptional({ enum: PRODUCT_SORTS, default: 'NAME_ASC' })
  @IsOptional() @IsIn(PRODUCT_SORTS) sort: ProductSort = 'NAME_ASC';
}

// Detail không nhận query nào; ?status=... → 400 (US-35-TC02).
export class PublicProductDetailQueryDto {}
