import { Transform, Type } from 'class-transformer';
import { ApiProperty, PickType } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsInt, IsMongoId, IsString, Length, Max, Min, ValidateNested } from 'class-validator';
import { CancelOrderDto } from '../orders/order-cancellation.dto';
import { RefundQueryDto } from '../refunds/refunds.dto';

export class ReturnItemInputDto {
  @ApiProperty() @IsMongoId() orderItemId!: string;
  @ApiProperty({ minimum: 1 }) @IsInt() @Min(1) @Max(2147483647) quantity!: number;
  @ApiProperty() @IsBoolean() restockable!: boolean;
  @ApiProperty({ minLength: 10, maxLength: 500 }) @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(10, 500) conditionNote!: string;
}
export class ReceiveReturnDto extends CancelOrderDto {
  @ApiProperty({ type: [ReturnItemInputDto], minItems: 1, maxItems: 100 }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100)
  @ValidateNested({ each: true }) @Type(() => ReturnItemInputDto) items!: ReturnItemInputDto[];
}
export class ReturnQueryDto extends PickType(RefundQueryDto, ['orderId', 'fromDate', 'toDate', 'page', 'limit'] as const) {}
export class ReceiveReturnResultDto {
  @ApiProperty() returnId!: string;
  @ApiProperty({ required: false }) refundId?: string;
  @ApiProperty({ enum: ['PENDING', 'NONE'] }) refundState!: string;
  @ApiProperty() amount!: string;
  @ApiProperty({ type: [String] }) movementIds!: string[];
  @ApiProperty() orderVersion!: number;
}
export class ReturnSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty() orderId!: string;
  @ApiProperty({ enum: ['WEBSITE', 'POS'] }) channel!: string;
  @ApiProperty() reason!: string;
  @ApiProperty() receivedAt!: string;
  @ApiProperty() createdBy!: string;
  @ApiProperty() amount!: string;
  @ApiProperty() refundAmount!: string;
  @ApiProperty() refundedAmount!: string;
  @ApiProperty() outstandingRefundAmount!: string;
  @ApiProperty({ type: [Object], description: 'id, status, amount' }) refunds!: Record<string, unknown>[];
}
export class ReturnItemResultDto extends ReturnItemInputDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() sku!: string;
  @ApiProperty() unitPrice!: string;
  @ApiProperty() amount!: string;
}
export class ReturnDetailDto extends ReturnSummaryDto {
  @ApiProperty({ type: [ReturnItemResultDto] }) items!: ReturnItemResultDto[];
  @ApiProperty() asOf!: string;
}
export class ReturnPageDto {
  @ApiProperty({ type: [ReturnSummaryDto] }) items!: ReturnSummaryDto[];
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
  @ApiProperty() asOf!: string;
}
export class ReturnEligibilityItemDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() sku!: string;
  @ApiProperty() quantity!: number;
  @ApiProperty() remaining!: number;
  @ApiProperty() unitPrice!: string;
}
export class ReturnEligibilityDto {
  @ApiProperty() id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() channel!: string;
  @ApiProperty() status!: string;
  @ApiProperty() version!: number;
  @ApiProperty({ nullable: true, type: String }) fulfilledAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) returnDeadline!: string | null;
  @ApiProperty() eligible!: boolean;
  @ApiProperty({ type: [ReturnEligibilityItemDto] }) items!: ReturnEligibilityItemDto[];
  @ApiProperty() asOf!: string;
}
