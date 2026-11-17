// Tầng kiểm tra dữ liệu (US-19 bước 1): body Member gửi lên khi xem trước/tạo kỳ gia hạn cho chính mình.
// US-19-F01: KHÔNG có memberId/accountId/channel; field lạ bị ValidationPipe (forbidNonWhitelisted) chặn 400.
import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsMongoId, Max, Min } from 'class-validator';
import { PREFERRED_PAYMENT_METHODS, PreferredPaymentMethod } from '../memberships/schemas/service-sale.schema';

export class MeRenewalDto {
  @ApiProperty() @IsMongoId() previousSaleId!: string;
  @ApiProperty({ minimum: 0 }) @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) planVersion!: number;
  // Spec mục 2: cách trả dự kiến CASH/TRANSFER. Bước 1 chỉ kiểm tra định dạng; lưu vào sale làm ở bước 2.
  @ApiProperty({ enum: PREFERRED_PAYMENT_METHODS }) @IsIn(PREFERRED_PAYMENT_METHODS) preferredPaymentMethod!: PreferredPaymentMethod;
}
