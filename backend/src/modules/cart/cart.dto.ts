// Tầng kiểm tra dữ liệu (US-40 bước 1): body/query của lệnh thêm, sửa số lượng và xóa dòng giỏ.
// CHỈ nhận field có khai báo; memberId/accountId/role/price… → 400 vì ValidationPipe forbidNonWhitelisted (US-40-TC02).
// Idempotency-Key đọc từ header bằng @IdempotencyKey() (EN-02), không nằm trong DTO.
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsMongoId, Max, Min } from 'class-validator';
import { CART_QUANTITY_MAX, CART_QUANTITY_MIN } from './schemas/cart.schema';

// Version là Int32 trong cart_states.
const VERSION_MAX = 2147483647;

// Query trên URL luôn là chuỗi. Chỉ đổi "0", "7"… (số nguyên ≥ 0 viết đúng dạng) sang số;
// "-1", "1.5", "1e2", "" giữ nguyên để @IsInt báo 400 (không tự sửa giá trị sai).
function queryVersion({ value }: { value: unknown }): unknown {
  return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) ? Number(value) : value;
}

// POST /api/me/cart/items – quantity là lượng THÊM vào dòng hiện có (US-40-F02).
export class AddCartItemDto {
  // US-40-C01: version đọc từ GET hiện tại để kiểm xung đột.
  @ApiProperty({ example: 0, minimum: 0 })
  @IsInt() @Min(0) @Max(VERSION_MAX) version!: number;

  // US-40-TC04: productId phải là ObjectId 24 ký tự hex.
  @ApiProperty({ example: '6650a1b2c3d4e5f6a7b8c9d0' })
  @IsMongoId({ message: 'productId không hợp lệ' }) productId!: string;

  // US-40-TC04: JSON integer 1–999; 0, âm, số lẻ, chuỗi "2" → 400.
  @ApiProperty({ example: 1, minimum: CART_QUANTITY_MIN, maximum: CART_QUANTITY_MAX })
  @IsInt() @Min(CART_QUANTITY_MIN) @Max(CART_QUANTITY_MAX) quantity!: number;
}

// PUT /api/me/cart/items/:productId – quantity là số TUYỆT ĐỐI; productId nằm trên URL (US-40-F02).
export class SetCartItemDto {
  @ApiProperty({ example: 1, minimum: 0 })
  @IsInt() @Min(0) @Max(VERSION_MAX) version!: number;

  // US-40-TC04: quantity 0 → 400, muốn xóa dòng phải dùng DELETE.
  @ApiProperty({ example: 3, minimum: CART_QUANTITY_MIN, maximum: CART_QUANTITY_MAX })
  @IsInt() @Min(CART_QUANTITY_MIN) @Max(CART_QUANTITY_MAX) quantity!: number;
}

// productId trên đường dẫn của PUT/DELETE; sai định dạng → 400.
export class CartItemParamDto {
  @ApiProperty({ example: '6650a1b2c3d4e5f6a7b8c9d0' })
  @IsMongoId({ message: 'productId không hợp lệ' }) productId!: string;
}

// DELETE /api/me/cart/items/:productId?version= – không có body, version bắt buộc integer ≥ 0.
export class RemoveCartItemQueryDto {
  @ApiProperty({ example: 2, minimum: 0 })
  @Transform(queryVersion) @IsInt() @Min(0) @Max(VERSION_MAX) version!: number;
}
