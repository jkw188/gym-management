// Tầng kiểm tra dữ liệu (US-41 bước 2): body của POST /api/me/orders/preview và POST /api/me/orders.
// Chỉ nhận đúng các field trong allowlist; memberId, giá, tổng, trạng thái... gửi lên đều bị 400 (US-41-TC02).
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsString, Length, Max, Min } from 'class-validator';

const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;

export class WebsitePreviewDto {
  // Version giỏ người dùng đang xem; khác version hiện tại thì 409 CART_VERSION_CONFLICT.
  @ApiProperty({ minimum: 0 }) @IsInt() @Min(0) @Max(2147483647) cartVersion!: number;
}

export class WebsiteCreateDto extends WebsitePreviewDto {
  @ApiProperty() @IsString() @Length(1, 50000) quoteToken!: string;
  // US-41-F01: tên người nhận trim rồi 2–120 ký tự.
  @ApiProperty({ minLength: 2, maxLength: 120 }) @Transform(trim) @IsString() @Length(2, 120) recipientName!: string;
  // Định dạng chi tiết kiểm và chuẩn hóa bằng normalizePhone (EN01-D01) trong service.
  @ApiProperty() @Transform(trim) @IsString() @Length(8, 30) recipientPhone!: string;
  // US-41-F04: chỉ là ý định cách trả, không phải bằng chứng đã trả.
  @ApiProperty({ enum: ['CASH', 'TRANSFER'] }) @IsIn(['CASH', 'TRANSFER']) preferredPaymentMethod!: 'CASH' | 'TRANSFER';
}
