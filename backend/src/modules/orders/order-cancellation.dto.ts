import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsString, Length, Matches } from 'class-validator';
import { PrepareOrderDto } from './orders.dto';

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
