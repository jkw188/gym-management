import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsMongoId, Max, Min } from 'class-validator';

export class UpgradeSourceDto {
  @ApiProperty() @IsMongoId() memberId!: string;
  @ApiProperty() @IsMongoId() sourceMembershipId!: string;
}
export class UpgradeDto extends UpgradeSourceDto {
  @ApiProperty() @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) sourceVersion!: number;
  @ApiProperty() @IsMongoId() targetPlanId!: string;
  @ApiProperty() @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) targetPlanVersion!: number;
  @ApiProperty() @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) policyVersion!: number;
}
