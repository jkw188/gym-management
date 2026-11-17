import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsMongoId, IsString, ValidateIf } from 'class-validator';
import { OrderQueryDto } from '../orders/orders.dto';
import { PickType } from '@nestjs/swagger';
import { REFUND_STATUSES } from './refund.schema';
import { Transform } from 'class-transformer';
import { IsISO8601, Length, Matches, isISO8601 } from 'class-validator';
import { PrepareOrderDto } from '../orders/orders.dto';

const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;
const reference = ({ value }: { value: unknown }) => typeof value === 'string' ? value.normalize('NFKC').trim().toUpperCase() : value;
export class ConfirmRefundDto extends PrepareOrderDto {
  @ApiProperty({ enum: ['CASH', 'TRANSFER'] }) @IsIn(['CASH', 'TRANSFER']) method!: 'CASH' | 'TRANSFER';
  @ApiProperty() @Transform(({ value }: { value: unknown }) => typeof value === 'string' && /^\d{1,12}$/.test(value) ? BigInt(value).toString() : value)
  @IsString() @Matches(/^\d{1,12}$/) amount!: string;
  @ApiProperty() @IsString() @IsISO8601({ strict: true }) @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/)
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' && isISO8601(value, { strict: true }) && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : value) paidOutAt!: string;
  @ApiProperty() @Transform(trim) @IsString() @Length(10, 500) evidenceNote!: string;
  @ApiPropertyOptional() @Transform(reference) @ValidateIf((_, value) => value !== undefined) @IsString() @Matches(/^[A-Z0-9_-]{1,40}$/) payoutAccountCode?: string;
  @ApiPropertyOptional() @Transform(reference) @ValidateIf((_, value) => value !== undefined) @IsString() @Length(1, 100) bankReference?: string;
  @ApiPropertyOptional() @Transform(reference) @ValidateIf((_, value) => value !== undefined) @IsString() @Length(1, 100) cashVoucherReference?: string;
}
export class FailRefundDto extends PrepareOrderDto {
  @ApiProperty() @Transform(trim) @IsString() @Length(10, 500) failureReason!: string;
  @ApiProperty() @Transform(trim) @IsString() @Length(10, 500) evidenceNote!: string;
}

export class RefundQueryDto extends PickType(OrderQueryDto, ['fromDate', 'toDate', 'page', 'limit'] as const) {
  @ApiPropertyOptional() @ValidateIf((_, value) => value !== undefined) @IsMongoId() orderId?: string;
  @ApiPropertyOptional({ enum: REFUND_STATUSES }) @ValidateIf((_, value) => value !== undefined) @IsString() @IsIn(REFUND_STATUSES) status?: typeof REFUND_STATUSES[number];
}
export class RefundSummaryDto {
  @ApiProperty() version!: number;
  @ApiProperty({ nullable: true, enum: ['CASH', 'TRANSFER'] }) method!: string | null;
  @ApiProperty() refundAmount!: string;
  @ApiProperty() refundedAmount!: string;
  @ApiProperty() outstandingRefundAmount!: string;
  @ApiProperty({ required: false }) attemptCount?: number;
  @ApiProperty() id!: string;
  @ApiProperty() orderId!: string;
  @ApiProperty() paymentId!: string;
  @ApiProperty({ nullable: true, type: String }) returnId!: string | null;
  @ApiProperty({ enum: ['CANCELLATION', 'RETURN'] }) source!: string;
  @ApiProperty({ description: 'Mã nội bộ RF, không phải mã chuyển tiền ngân hàng' }) reference!: string;
  @ApiProperty({ example: '50000' }) amount!: string;
  @ApiProperty({ enum: REFUND_STATUSES }) status!: string;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ nullable: true, type: String }) refundedAt!: string | null;
}
export class RefundPaymentDto {
  @ApiProperty() id!: string;
  @ApiProperty() transactionId!: string;
  @ApiProperty() method!: string;
  @ApiProperty() amount!: string;
  @ApiProperty() status!: string;
  @ApiProperty() reference!: string;
  @ApiProperty() receiptPurpose!: string;
  @ApiProperty({ nullable: true, type: String }) paidAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) verifiedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) evidenceNote!: string | null;
}
export class RefundDetailDto extends RefundSummaryDto {
  @ApiProperty() obligationKey!: string;
  @ApiProperty({ nullable: true, type: Object }) payoutEvidence!: Record<string, unknown> | null;
  @ApiProperty({ nullable: true, type: String }) failureReason!: string | null;
  @ApiProperty({ nullable: true, type: String }) verifiedBy!: string | null;
  @ApiProperty({ nullable: true, type: String }) verifiedAt!: string | null;
  @ApiProperty({ type: [Object], description: 'Append-only: statusBefore/statusAfter, actorId, occurredAt, evidenceNote, failureReason, method, payoutEvidence, paidOutAt' }) attempts!: Record<string, unknown>[];
  @ApiProperty() asOf!: string;
  @ApiProperty({ nullable: true, type: String }) createdBy!: string | null;
  @ApiProperty({ enum: ['USER', 'SYSTEM'] }) actorType!: string;
  @ApiProperty({ nullable: true, type: String }) orderCode!: string | null;
  @ApiProperty({ nullable: true, type: String }) cancellationReason!: string | null;
  @ApiProperty({ nullable: true, type: String }) cancelledAt!: string | null;
  @ApiProperty({ nullable: true, type: RefundPaymentDto }) payment!: RefundPaymentDto | null;
}
export class RefundPageDto {
  @ApiProperty() asOf!: string;
  @ApiProperty({ type: [RefundSummaryDto] }) items!: RefundSummaryDto[];
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
}
export class PayoutResultDto {
  @ApiProperty() id!: string;
  @ApiProperty() orderId!: string;
  @ApiProperty({ enum: ['SUCCEEDED', 'FAILED'] }) status!: string;
  @ApiProperty() version!: number;
  @ApiProperty() amount!: string;
  @ApiProperty({ nullable: true, type: String }) refundedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) verifiedAt!: string | null;
}
