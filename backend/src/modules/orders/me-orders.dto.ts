// Tầng kiểm tra dữ liệu (US-42 bước 1): query của GET /api/me/orders và kiểu response các route own của Member.
// Chỉ nhận các query trong allowlist; memberId/accountId do client gửi bị ValidationPipe trả 400 (US-42-TC02).
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsString, Length, Matches, Max, Min, ValidateIf } from 'class-validator';
import { queryInteger } from '../../common/utils/query-integer';
import { ORDER_STATUSES, OrderStatus } from './order.schema';

const optional = (_: unknown, value: unknown) => value !== undefined;
const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;

export class OwnOrderQueryDto {
  // US-42-TC06: q cắt khoảng trắng, dài 1–120 ký tự; quá 120 → 400.
  @ApiPropertyOptional({ maxLength: 120 }) @ValidateIf(optional) @Transform(trim) @IsString() @Length(1, 120) q?: string;
  @ApiPropertyOptional({ enum: ORDER_STATUSES }) @ValidateIf(optional) @IsIn(ORDER_STATUSES) status?: OrderStatus;
  @ApiPropertyOptional({ enum: ['WEBSITE', 'POS'] }) @ValidateIf(optional) @IsIn(['WEBSITE', 'POS']) channel?: 'WEBSITE' | 'POS';
  // Định dạng YYYY-MM-DD kiểm ở đây; ngày có thật và khoảng tối đa 366 ngày kiểm trong service.
  @ApiPropertyOptional({ example: '2026-11-01' }) @ValidateIf(optional) @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) fromDate?: string;
  @ApiPropertyOptional({ example: '2026-11-30' }) @ValidateIf(optional) @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) toDate?: string;
  @ApiPropertyOptional({ default: 1 }) @Transform(queryInteger) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) page = 1;
  @ApiPropertyOptional({ default: 20, maximum: 100 }) @Transform(queryInteger) @IsInt() @Min(1) @Max(100) limit = 20;
}

export class OwnOrderListItemResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() code!: string;
  @ApiProperty({ enum: ['WEBSITE', 'POS'] }) channel!: string;
  @ApiProperty({ enum: ORDER_STATUSES }) status!: string;
  @ApiProperty({ nullable: true, type: String }) transactionStatus!: string | null;
  @ApiProperty({ nullable: true, type: String }) total!: string | null;
  @ApiProperty() reservationExpiresAt!: string;
  @ApiProperty({ enum: ['NONE', 'PENDING', 'FAILED', 'SUCCEEDED'] }) refundState!: string;
  @ApiProperty() createdAt!: string;
}
export class OwnOrderPageResponseDto {
  @ApiProperty() memberLinked!: boolean;
  @ApiProperty({ type: [OwnOrderListItemResponseDto] }) items!: OwnOrderListItemResponseDto[];
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
  @ApiProperty() asOf!: string;
}
export class OwnOrderLineResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() sku!: string;
  @ApiProperty() name!: string;
  @ApiProperty() unitPrice!: string;
  @ApiProperty() quantity!: number;
  @ApiProperty() lineTotal!: string;
}
export class OwnOrderDetailResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() code!: string;
  @ApiProperty({ enum: ['WEBSITE', 'POS'] }) channel!: string;
  @ApiProperty({ enum: ORDER_STATUSES }) status!: string;
  @ApiProperty() version!: number;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ nullable: true, type: String }) confirmedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) fulfilledAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) cancelledAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) cancellationReason!: string | null;
  @ApiProperty({ enum: ['HELD', 'CONSUMED', 'RELEASED'] }) reservationState!: string;
  @ApiProperty() reservationExpiresAt!: string;
  @ApiProperty() expired!: boolean;
  @ApiProperty() cancelAllowed!: boolean;
  @ApiProperty() paymentAllowed!: boolean;
  @ApiProperty({ enum: ['CASH', 'TRANSFER'] }) preferredPaymentMethod!: string;
  @ApiProperty() recipientName!: string;
  @ApiProperty({ nullable: true, type: String }) recipientPhone!: string | null;
  @ApiProperty() pickupLocation!: string;
  @ApiProperty({ type: [OwnOrderLineResponseDto] }) items!: OwnOrderLineResponseDto[];
  @ApiProperty({ nullable: true, type: String }) total!: string | null;
  @ApiProperty({ nullable: true, type: String }) transactionStatus!: string | null;
  @ApiProperty({ enum: ['NONE', 'PENDING', 'FAILED', 'SUCCEEDED'] }) refundState!: string;
  @ApiProperty() refundAmount!: string;
  @ApiProperty({ nullable: true, type: String }) invoiceId!: string | null;
  @ApiProperty() asOf!: string;
}
export class OwnTransferOptionResponseDto {
  @ApiProperty() receivingAccountCode!: string;
  @ApiProperty() bankName!: string;
  @ApiProperty() accountNumber!: string;
  @ApiProperty() accountName!: string;
  @ApiProperty() transferContent!: string;
}
export class OwnPaymentInstructionsResponseDto {
  @ApiProperty() transactionCode!: string;
  @ApiProperty() amountDue!: string;
  @ApiProperty({ enum: ['CASH', 'TRANSFER'] }) preferredPaymentMethod!: string;
  @ApiProperty() pickupLocation!: string;
  @ApiProperty() cashInstructions!: string;
  @ApiPropertyOptional({ type: [OwnTransferOptionResponseDto] }) transferOptions?: OwnTransferOptionResponseDto[];
}
export class OwnInvoiceLineResponseDto {
  @ApiProperty() sku!: string;
  @ApiProperty() name!: string;
  @ApiProperty() unitPrice!: string;
  @ApiProperty() quantity!: number;
  @ApiProperty() lineTotal!: string;
}
export class OwnInvoicePaymentResponseDto {
  @ApiProperty({ enum: ['CASH', 'TRANSFER'] }) method!: string;
  @ApiProperty() amount!: string;
  @ApiProperty({ nullable: true, type: String }) paidAt!: string | null;
}
export class OwnInvoiceResponseDto {
  @ApiProperty() invoiceNo!: string;
  @ApiProperty() issuedAt!: string;
  @ApiProperty() buyerSnapshot!: string;
  @ApiProperty() total!: string;
  @ApiProperty({ type: [OwnInvoiceLineResponseDto] }) retailLines!: OwnInvoiceLineResponseDto[];
  @ApiProperty({ type: OwnInvoicePaymentResponseDto, nullable: true }) payment!: OwnInvoicePaymentResponseDto | null;
}
