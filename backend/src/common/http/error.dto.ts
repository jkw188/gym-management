import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

class ErrorDetailDto {
  @ApiProperty() field!: string;
  @ApiProperty() message!: string;
}
class ErrorBodyDto {
  @ApiProperty() code!: string;
  @ApiProperty() message!: string;
  @ApiPropertyOptional({ type: [ErrorDetailDto] }) details?: ErrorDetailDto[];
}
export class ErrorResponseDto {
  @ApiProperty({ type: ErrorBodyDto }) error!: ErrorBodyDto;
  @ApiProperty({ format: 'uuid' }) requestId!: string;
}
