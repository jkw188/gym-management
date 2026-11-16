import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsMongoId, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { queryInteger } from '../../common/utils/query-integer';
import { ORDER_STATUSES, OrderStatus } from './order.schema';

const optional = (_: unknown, value: unknown) => value !== undefined;
export class EmptyOrderQueryDto {}
export class PrepareOrderDto {
  @ApiProperty({ minimum: 0, maximum: 2147483647 }) @IsInt() @Min(0) @Max(2147483647) version!: number;
}
export class FulfillOrderDto extends PrepareOrderDto {}
export class FulfillOrderResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() code!: string;
  @ApiProperty({ enum: ['COMPLETED'] }) status!: 'COMPLETED';
  @ApiProperty({ enum: ['CONSUMED'] }) reservationState!: 'CONSUMED';
  @ApiProperty() version!: number;
  @ApiProperty() fulfilledAt!: string;
  @ApiProperty() fulfilledBy!: string;
  @ApiProperty({ type: [String] }) movementIds!: string[];
  @ApiProperty({ enum: ['STORED', 'NO_LINKED_ACCOUNT'] }) notificationState!: string;
}
export class OrderQueryDto {
  @ApiPropertyOptional({ enum: ['WEBSITE', 'POS'] }) @ValidateIf(optional) @IsIn(['WEBSITE', 'POS']) channel?: 'WEBSITE' | 'POS';
  @ApiPropertyOptional({ enum: ORDER_STATUSES }) @ValidateIf(optional) @IsIn(ORDER_STATUSES) status?: OrderStatus;
  @ApiPropertyOptional({ enum: ['PENDING', 'SETTLED', 'CANCELLED'] }) @ValidateIf(optional) @IsIn(['PENDING', 'SETTLED', 'CANCELLED']) transactionStatus?: string;
  @ApiPropertyOptional() @ValidateIf(optional) @IsMongoId() memberId?: string;
  @ApiPropertyOptional({ maxLength: 120 }) @ValidateIf(optional) @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @MaxLength(120) q?: string;
  @ApiPropertyOptional() @ValidateIf(optional) @IsString() fromDate?: string;
  @ApiPropertyOptional() @ValidateIf(optional) @IsString() toDate?: string;
  @ApiPropertyOptional({ default: 1 }) @Transform(queryInteger) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) page = 1;
  @ApiPropertyOptional({ default: 20, maximum: 100 }) @Transform(queryInteger) @IsInt() @Min(1) @Max(100) limit = 20;
}
export class PrepareOrderResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() code!: string;
  @ApiProperty({ enum: ['CONFIRMED'] }) status!: 'CONFIRMED';
  @ApiProperty() version!: number;
  @ApiProperty() confirmedAt!: string;
  @ApiProperty() confirmedBy!: string;
  @ApiProperty() reservationExpiresAt!: string;
  @ApiProperty({ enum: ['STORED', 'NO_LINKED_ACCOUNT'] }) notificationState!: string;
}
export class OrderActionsResponseDto {
  @ApiProperty() prepare!: boolean;
  @ApiProperty({ nullable: true, type: String }) prepareBlockedReason!: string | null;
  @ApiProperty() fulfill!: boolean;
  @ApiProperty({ nullable: true, type: String }) fulfillBlockedReason!: string | null;
}
export class OrderSummaryResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() code!: string;
  @ApiProperty({ enum: ['WEBSITE', 'POS'] }) channel!: string;
  @ApiProperty({ enum: ORDER_STATUSES }) status!: string;
  @ApiProperty() version!: number;
  @ApiProperty({ nullable: true, type: String }) memberId!: string | null;
  @ApiProperty() transactionId!: string;
  @ApiProperty({ nullable: true, enum: ['PENDING', 'SETTLED', 'CANCELLED'] }) transactionStatus!: string | null;
  @ApiProperty({ nullable: true, type: String, example: '25000' }) total!: string | null;
  @ApiProperty({ enum: ['HELD', 'CONSUMED', 'RELEASED'] }) reservationState!: string;
  @ApiProperty() reservationExpiresAt!: string;
  @ApiProperty() expired!: boolean;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
  @ApiProperty({ type: OrderActionsResponseDto }) permittedActions!: OrderActionsResponseDto;
}
export class OrderItemResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() productId!: string;
  @ApiProperty() skuSnapshot!: string;
  @ApiProperty() nameSnapshot!: string;
  @ApiProperty() quantity!: number;
  @ApiProperty({ example: '25000' }) unitPrice!: string;
  @ApiProperty({ example: '25000' }) lineTotal!: string;
}
export class OrderRecipientResponseDto {
  @ApiProperty() name!: string;
  @ApiProperty() phone!: string;
}
export class OrderInvoiceResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() invoiceNo!: string;
  @ApiProperty() totalAmount!: string;
  @ApiProperty() issuedAt!: string;
}
export class OrderRefundResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ['PENDING', 'FAILED', 'SUCCEEDED'] }) status!: string;
  @ApiProperty() amount!: string;
}
export class OrderDetailResponseDto extends OrderSummaryResponseDto {
  @ApiProperty({ type: OrderRecipientResponseDto }) recipient!: OrderRecipientResponseDto;
  @ApiProperty() pickupLocation!: string;
  @ApiProperty({ nullable: true, type: String }) confirmedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) confirmedBy!: string | null;
  @ApiProperty({ nullable: true, type: String }) fulfilledAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) fulfilledBy!: string | null;
  @ApiProperty({ type: [String] }) movementIds!: string[];
  @ApiProperty({ type: [OrderItemResponseDto] }) items!: OrderItemResponseDto[];
  @ApiProperty({ type: OrderInvoiceResponseDto, nullable: true }) invoice!: OrderInvoiceResponseDto | null;
  @ApiProperty({ type: [OrderRefundResponseDto] }) refunds!: OrderRefundResponseDto[];
  @ApiProperty() asOf!: string;
}
export class OrderPageResponseDto {
  @ApiProperty({ type: [OrderSummaryResponseDto] }) items!: OrderSummaryResponseDto[];
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
  @ApiProperty() asOf!: string;
}
