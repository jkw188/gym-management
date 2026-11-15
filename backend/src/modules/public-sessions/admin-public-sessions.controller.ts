import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { ApiBearerAuth, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IdempotencyKey } from '../../common/decorators/idempotency-key.decorator';
import { ErrorResponseDto } from '../../common/http/error.dto';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { FixedPermission } from '../users/access.policy';
import { AdminSessionPageDto, AdminSessionQueryDto, AdminSessionResponseDto, CancelPublicSessionDto, CreatePublicSessionDto, PreviewPublicSessionDto, SessionPreviewResponseDto, SessionVersionDto, UpdatePublicSessionDto } from './admin-public-sessions.dto';
import { AdminPublicSessionsService } from './admin-public-sessions.service';

@Controller('admin/public-sessions')
@FixedPermission('publicSessions.manage')
@ApiTags('admin-public-sessions') @ApiBearerAuth()
@ApiResponse({ status: 400, type: ErrorResponseDto }) @ApiResponse({ status: 401, type: ErrorResponseDto })
@ApiResponse({ status: 403, type: ErrorResponseDto }) @ApiResponse({ status: 404, type: ErrorResponseDto })
@ApiResponse({ status: 409, type: ErrorResponseDto }) @ApiResponse({ status: 503, type: ErrorResponseDto })
export class AdminPublicSessionsController {
  constructor(private readonly sessions: AdminPublicSessionsService) {}
  @Get() @ApiOkResponse({ type: AdminSessionPageDto }) list(@Query() query: AdminSessionQueryDto) { return this.sessions.list(query); }
  @Get(':id') @ApiOkResponse({ type: AdminSessionResponseDto }) detail(@Param('id') id: string) { return this.sessions.detail(id); }
  @Post('preview') @HttpCode(200) @ApiOkResponse({ type: SessionPreviewResponseDto })
  preview(@Body() input: PreviewPublicSessionDto) { return this.sessions.preview(input); }
  @Post() @ApiHeader({ name: 'Idempotency-Key', required: true }) @ApiCreatedResponse({ type: AdminSessionResponseDto })
  async create(@CurrentUser() user: AuthPrincipal, @IdempotencyKey() key: string, @Body() input: CreatePublicSessionDto,
    @Res({ passthrough: true }) response: Response) {
    const result = await this.sessions.create(user.id, input, key); response.status(result.status); return result.body;
  }
  @Patch(':id') @ApiHeader({ name: 'Idempotency-Key', required: true }) @ApiOkResponse({ type: AdminSessionResponseDto })
  async update(@CurrentUser() user: AuthPrincipal, @Param('id') id: string, @IdempotencyKey() key: string,
    @Body() input: UpdatePublicSessionDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.sessions.update(user.id, id, input, key); response.status(result.status); return result.body;
  }
  @Post(':id/publish') @ApiHeader({ name: 'Idempotency-Key', required: true }) @ApiOkResponse({ type: AdminSessionResponseDto })
  async publish(@CurrentUser() user: AuthPrincipal, @Param('id') id: string, @IdempotencyKey() key: string,
    @Body() input: SessionVersionDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.sessions.publish(user.id, id, input, key); response.status(result.status); return result.body;
  }
  @Post(':id/cancel') @ApiHeader({ name: 'Idempotency-Key', required: true }) @ApiOkResponse({ type: AdminSessionResponseDto })
  async cancel(@CurrentUser() user: AuthPrincipal, @Param('id') id: string, @IdempotencyKey() key: string,
    @Body() input: CancelPublicSessionDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.sessions.cancel(user.id, id, input, key); response.status(result.status); return result.body;
  }
}
