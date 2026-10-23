import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ErrorResponseDto } from '../../common/http/error.dto';
import { HealthService } from './health.service';
import { Public } from '../auth/auth.decorators';

class LiveResponseDto { @ApiProperty({ enum: ['ok'] }) status!: 'ok'; }
class ReadyResponseDto { @ApiProperty({ enum: ['ready'] }) status!: 'ready'; }

// Public infrastructure endpoints. US-02 must preserve anonymous access.
@ApiTags('health')
@Controller('health')
@Public()
export class HealthController {
  constructor(private readonly health: HealthService) {}
  @Get('live')
  @ApiOkResponse({ type: LiveResponseDto, headers: { 'X-Request-Id': { schema: { type: 'string', format: 'uuid' } } } })
  live() { return this.health.live(); }

  @Get('ready')
  @ApiOkResponse({ type: ReadyResponseDto, headers: { 'X-Request-Id': { schema: { type: 'string', format: 'uuid' } } } })
  @ApiResponse({ status: 503, type: ErrorResponseDto })
  ready() { return this.health.ready(); }
}
