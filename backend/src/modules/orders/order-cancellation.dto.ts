import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsString, Length, Matches } from 'class-validator';
import { PrepareOrderDto } from './orders.dto';
import { OrderRefundResponseDto } from './orders.dto';

export class CancelOrderDto extends PrepareOrderDto {
  @ApiProperty({ minLength: 10, maxLength: 500 }) @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(10, 500) reason!: string;
}
export class LateReceiptDto {
  @ApiProperty({ enum: ['TRANSFER'] }) @IsIn(['TRANSFER']) method!: 'TRANSFER';
  @ApiProperty() @IsString() @Matches(/^\d{1,12}$/) amount!: string;
  @ApiProperty() @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value) @IsString() @Length(10, 500) evidenceNote!: string;
  @ApiProperty() @IsString() @Matches(/^[A-Z0-9_-]{1,40}$/) receivingAccountCode!: string;
  @ApiProperty() @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value) @IsString() @Length(1, 100) bankReference!: string;
  @ApiProperty() @IsString() @IsISO8601({ strict: true }) @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/) receivedAt!: string;
}
export class CancelOrderResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() code!: string;
  @ApiProperty({ enum: ['CANCELLED'] }) status!: 'CANCELLED';
  @ApiProperty() version!: number;
  @ApiProperty({ enum: ['RELEASED'] }) reservationState!: 'RELEASED';
  @ApiProperty() cancelledAt!: string;
  @ApiProperty() transactionStatus!: string;
  @ApiProperty() refundState!: string;
  @ApiProperty() refundAmount!: string;
  @ApiProperty({ required: false }) refundId?: string;
  @ApiProperty() notificationState!: string;
}
export class LateReceiptResponseDto {
  @ApiProperty() orderId!: string;
  @ApiProperty() paymentId!: string;
  @ApiProperty() refundId!: string;
  @ApiProperty({ enum: ['PENDING'] }) refundState!: 'PENDING';
  @ApiProperty({ enum: ['CANCELLED'] }) transactionStatus!: 'CANCELLED';
  @ApiProperty() notificationState!: string;
}
export class OwnOrderItemResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() quantity!: number;
  @ApiProperty() lineTotal!: string;
}
export class OwnOrderResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() code!: string;
  @ApiProperty({ enum: ['WEBSITE', 'POS'] }) channel!: string;
  @ApiProperty({ enum: ['PENDING', 'CONFIRMED', 'COMPLETED', 'CANCELLED'] }) status!: string;
  @ApiProperty() version!: number;
  @ApiProperty() reservationState!: string;
  @ApiProperty() reservationExpiresAt!: string;
  @ApiProperty() expired!: boolean;
  @ApiProperty() asOf!: string;
  @ApiProperty({ nullable: true, type: String }) total!: string | null;
  @ApiProperty({ nullable: true, type: String }) transactionStatus!: string | null;
  @ApiProperty({ nullable: true, type: String }) cancelledAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) cancellationReason!: string | null;
  @ApiProperty({ type: [OwnOrderItemResponseDto] }) items!: OwnOrderItemResponseDto[];
  @ApiProperty({ type: [OrderRefundResponseDto] }) refunds!: OrderRefundResponseDto[];
}
export class OwnOrderPageResponseDto {
  @ApiProperty({ type: [OwnOrderResponseDto] }) items!: OwnOrderResponseDto[];
  @ApiProperty() memberLinked!: boolean;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
}
