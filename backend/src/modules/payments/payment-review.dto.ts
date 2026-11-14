import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsISO8601, IsOptional, IsString, Length, Matches, MaxLength, ValidateIf } from 'class-validator';
import { MeListQueryDto } from '../memberships/me-memberships.dto';
import { PaymentMethod } from './schemas/payment.schema';

const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;

export class TransactionQueryDto extends MeListQueryDto {
  // RETAIL is recognized here so the service can return the specified UNSUPPORTED_KIND code.
  @ApiPropertyOptional({ enum: ['GYM', 'PT'] })
  @IsOptional() @IsIn(['GYM', 'PT', 'RETAIL']) kind?: 'GYM' | 'PT' | 'RETAIL';

  @ApiPropertyOptional({ enum: ['PENDING', 'SETTLED', 'CANCELLED'] })
  @IsOptional() @IsIn(['PENDING', 'SETTLED', 'CANCELLED']) status?: 'PENDING' | 'SETTLED' | 'CANCELLED';

  @ApiPropertyOptional() @IsOptional() @Matches(/^[a-f0-9]{24}$/i) memberId?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(40) q?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) createdFrom?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) createdTo?: string;
}

// Shared input boundary for US-21 preview and future US-22 confirmation.
// Optional transfer fields on CASH are rejected by normalizePaymentReview, never silently ignored.
export class PaymentReviewDto {
  @ApiProperty({ enum: ['CASH', 'TRANSFER'] }) @IsIn(['CASH', 'TRANSFER']) method!: PaymentMethod;
  @ApiProperty({ example: '300000' }) @IsString() @Matches(/^\d{1,12}$/) amount!: string;
  @ApiProperty() @Transform(trim) @IsString() @Length(10, 500) evidenceNote!: string;

  @ApiPropertyOptional() @ValidateIf((_object, value) => value !== undefined)
  @IsString() @Matches(/^[A-Z0-9_-]{1,40}$/) receivingAccountCode?: string;

  @ApiPropertyOptional() @ValidateIf((_object, value) => value !== undefined)
  @Transform(trim) @IsString() @Length(1, 100) bankReference?: string;

  @ApiPropertyOptional() @ValidateIf((_object, value) => value !== undefined)
  @IsString() @IsISO8601({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/)
  receivedAt?: string;
}
