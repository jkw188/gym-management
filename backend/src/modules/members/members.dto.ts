import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsString, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { VERIFICATION_METHODS, VerificationMethod } from './schemas/member-link-event.schema';

const present = (_object: unknown, value: unknown) => value !== undefined;
export class CreateMemberDto {
  @ApiProperty({ minLength: 2, maxLength: 120 }) @IsString() fullName!: string;
  @ApiProperty() @IsString() @MaxLength(32) phone!: string;
  @ApiPropertyOptional({ example: '2000-01-31' }) @ValidateIf(present) @IsString() birthDate?: string;
  @ApiPropertyOptional({ maxLength: 255 }) @ValidateIf(present) @IsString() address?: string;
}
export class LinkCandidatesQueryDto {
  @ApiProperty() @IsString() @MaxLength(32) phone!: string;
}
export class LinkMemberDto {
  @ApiProperty() @Matches(/^[a-f\d]{24}$/i) accountId!: string;
  @ApiProperty({ minimum: 0 }) @IsInt() @Min(0) @Max(2147483646) version!: number;
  @ApiProperty({ enum: VERIFICATION_METHODS }) @IsIn(VERIFICATION_METHODS) verificationMethod!: VerificationMethod;
  @ApiProperty({ minLength: 10, maxLength: 500 }) @IsString() verificationNote!: string;
}
export class MemberDto {
  @ApiProperty() id!: string;
  @ApiProperty() memberCode!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty() phone!: string;
  @ApiPropertyOptional() birthDate?: string;
  @ApiPropertyOptional() address?: string;
  @ApiPropertyOptional() accountId?: string;
  @ApiProperty() version!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}
export class LinkMemberResponseDto {
  @ApiProperty({ type: MemberDto }) member!: MemberDto;
  @ApiProperty({ example: true }) linked!: boolean;
}
export class LinkCandidateDto {
  @ApiProperty() id!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty() phone!: string;
  @ApiProperty() canLink!: boolean;
}
export class LinkCandidatesResponseDto {
  @ApiProperty({ type: [LinkCandidateDto] }) items!: LinkCandidateDto[];
}
