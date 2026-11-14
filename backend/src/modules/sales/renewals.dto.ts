import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsMongoId, Max, Min } from 'class-validator';

export class RenewalDto {
  @ApiProperty() @IsMongoId() memberId!: string;
  @ApiProperty() @IsMongoId() previousSaleId!: string;
  @ApiProperty({ minimum: 0 }) @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) planVersion!: number;
}

export class RenewalPreviewResponseDto {
  @ApiProperty() previousSaleId!: string;
  @ApiProperty() sourceEndDate!: string;
  @ApiProperty() amountDue!: string;
  @ApiProperty() expectedStartDate!: string;
  @ApiProperty() expectedEndDate!: string;
  @ApiProperty() planVersion!: number;
  @ApiProperty() asOf!: string;
  @ApiProperty() canProceed!: boolean;
  @ApiProperty({ required: false }) blockingCode?: string;
}
