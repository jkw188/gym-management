// Tầng kiểm tra dữ liệu (US-19 bước 1–2): body Member gửi lên khi xem trước/tạo kỳ gia hạn cho chính mình.
// US-19-F01: KHÔNG có memberId/accountId/channel; field lạ bị ValidationPipe (forbidNonWhitelisted) chặn 400.
import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsMongoId, Max, Min } from 'class-validator';
import { PREFERRED_PAYMENT_METHODS, PreferredPaymentMethod } from '../memberships/schemas/service-sale.schema';

export class MeRenewalDto {
  @ApiProperty() @IsMongoId() previousSaleId!: string;
  @ApiProperty({ minimum: 0 }) @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) planVersion!: number;
  // US-19-F03, TC08: cách trả dự kiến CASH/TRANSFER, server lưu vào service_sales.preferred_payment_method.
  @ApiProperty({ enum: PREFERRED_PAYMENT_METHODS }) @IsIn(PREFERRED_PAYMENT_METHODS) preferredPaymentMethod!: PreferredPaymentMethod;
}
