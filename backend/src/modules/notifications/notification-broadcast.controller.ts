import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { IdempotencyKey } from '../../common/decorators/idempotency-key.decorator';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { FixedPermission } from '../users/access.policy';
import { BroadcastDetailResponseDto, BroadcastPageResponseDto, BroadcastParamDto, BroadcastPreviewResponseDto, BroadcastQueryDto, BroadcastSentResponseDto, EmptyBroadcastQueryDto, PreviewBroadcastDto, SendBroadcastDto } from './notification-broadcast.dto';
import { NotificationBroadcastService } from './notification-broadcast.service';

@ApiTags('Notification broadcasts') @ApiBearerAuth()
@Controller('admin/notification-broadcasts') @FixedPermission('notifications.broadcast')
export class NotificationBroadcastController {
  constructor(private readonly service: NotificationBroadcastService) {}
  @Post('preview') @ApiCreatedResponse({ type: BroadcastPreviewResponseDto })
  preview(@CurrentUser() actor: AuthPrincipal, @Body() input: PreviewBroadcastDto, @Query() _query: EmptyBroadcastQueryDto) {
    return this.service.preview(actor.id, input);
  }
  @Post(':id/send') @ApiOkResponse({ type: BroadcastSentResponseDto }) @ApiHeader({ name: 'Idempotency-Key', required: true })
  async send(@CurrentUser() actor: AuthPrincipal, @Param() params: BroadcastParamDto, @Body() input: SendBroadcastDto,
    @IdempotencyKey() key: string, @Query() _query: EmptyBroadcastQueryDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.service.send(actor.id, params.id, input.version, key);
    response.status(result.status); return result.body;
  }
  @Get() @ApiOkResponse({ type: BroadcastPageResponseDto })
  list(@Query() query: BroadcastQueryDto) { return this.service.list(query); }
  @Get(':id') @ApiOkResponse({ type: BroadcastDetailResponseDto })
  detail(@Param() params: BroadcastParamDto, @Query() _query: EmptyBroadcastQueryDto) { return this.service.detail(params.id); }
}
