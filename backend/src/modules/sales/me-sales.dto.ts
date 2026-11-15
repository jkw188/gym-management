// Tầng kiểm tra dữ liệu (US-18 bước 1): body Member gửi lên khi xem trước/tạo yêu cầu mua gói cho chính mình.
// US-18-F01: KHÔNG có memberId/accountId/createdBy/role/channel; field lạ bị ValidationPipe (forbidNonWhitelisted) chặn 400.
import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsMongoId, IsString, Matches, Max, Min } from 'class-validator';

// US-18-F03: phương thức dự kiến chỉ là ý định thanh toán, không phải đã trả.
export const PREFERRED_PAYMENT_METHODS = ['CASH', 'TRANSFER'] as const;
export type PreferredPaymentMethod = typeof PREFERRED_PAYMENT_METHODS[number];

export class MeRegisterSaleDto {
  @ApiProperty() @IsMongoId() planId!: string;
  @ApiProperty({ minimum: 0 }) @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) planVersion!: number;
  @ApiProperty({ example: '2026-11-11' }) @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) startDate!: string;
  @ApiProperty({ enum: PREFERRED_PAYMENT_METHODS }) @IsIn(PREFERRED_PAYMENT_METHODS) preferredPaymentMethod!: PreferredPaymentMethod;
}
