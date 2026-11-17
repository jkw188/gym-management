// Tầng kiểm tra dữ liệu (US-20 bước 1): body Member gửi lên khi xem trước/tạo đề nghị nâng cấp gói của chính mình.
// US-20-F01: KHÔNG có memberId/credit/amountDue/quota/channel; field lạ bị ValidationPipe (forbidNonWhitelisted) chặn 400.
import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsMongoId, Max, Min } from 'class-validator';
import { PREFERRED_PAYMENT_METHODS, PreferredPaymentMethod } from '../memberships/schemas/service-sale.schema';

export class MeUpgradeDto {
  @ApiProperty() @IsMongoId() sourceMembershipId!: string;
  // US-20-TC04: các version Member đọc được từ upgrade-options; lệch với server thì UpgradeService trả 409.
  @ApiProperty({ minimum: 0 }) @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) sourceVersion!: number;
  @ApiProperty() @IsMongoId() targetPlanId!: string;
  @ApiProperty({ minimum: 0 }) @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) targetPlanVersion!: number;
  @ApiProperty({ minimum: 0 }) @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) policyVersion!: number;
  // US-20 mục 2: cách trả dự kiến CASH/TRANSFER. Bước 1 chỉ kiểm định dạng; lưu vào sale thuộc bước 2.
  @ApiProperty({ enum: PREFERRED_PAYMENT_METHODS }) @IsIn(PREFERRED_PAYMENT_METHODS) preferredPaymentMethod!: PreferredPaymentMethod;
}
