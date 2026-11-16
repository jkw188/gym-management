import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsMongoId, IsString, ValidateIf } from 'class-validator';
import { OrderQueryDto } from '../orders/orders.dto';
import { PickType } from '@nestjs/swagger';
import { REFUND_STATUSES } from './refund.schema';

export class RefundQueryDto extends PickType(OrderQueryDto, ['fromDate', 'toDate', 'page', 'limit'] as const) {
  @ApiPropertyOptional() @ValidateIf((_, value) => value !== undefined) @IsMongoId() orderId?: string;
  @ApiPropertyOptional({ enum: REFUND_STATUSES }) @ValidateIf((_, value) => value !== undefined) @IsString() @IsIn(REFUND_STATUSES) status?: typeof REFUND_STATUSES[number];
}
export class RefundSummaryDto {
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
  @ApiProperty({ nullable: true, type: String }) createdBy!: string | null;
  @ApiProperty({ enum: ['USER', 'SYSTEM'] }) actorType!: string;
  @ApiProperty({ nullable: true, type: String }) orderCode!: string | null;
  @ApiProperty({ nullable: true, type: String }) cancellationReason!: string | null;
  @ApiProperty({ nullable: true, type: String }) cancelledAt!: string | null;
  @ApiProperty({ nullable: true, type: RefundPaymentDto }) payment!: RefundPaymentDto | null;
}
export class RefundPageDto {
  @ApiProperty({ type: [RefundSummaryDto] }) items!: RefundSummaryDto[];
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
}
