import { Body, Controller, Get, Param, Post, Patch, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { IdempotencyKey } from '../../common/decorators/idempotency-key.decorator';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { FixedPermission } from '../users/access.policy';
import { CreateIssueDto, EmptyStockQueryDto, PostReceiptDto, PostedIssueResponseDto, ReceiptPageResponseDto, ReceiptQueryDto, IssueResponseDto, UpdateIssueDto } from './stock-issues.dto';
import { StockIssuesService } from './stock-issues.service';

@ApiTags('Stock issues') @ApiBearerAuth()
@Controller('stock-issues') @FixedPermission('stockIssues.manage')
export class StockIssuesController {
  constructor(private readonly service: StockIssuesService) {}
  @Get() @ApiOkResponse({ type: ReceiptPageResponseDto })
  list(@Query() query: ReceiptQueryDto) { return this.service.list(query); }
  @Get(':id') @ApiOkResponse({ type: IssueResponseDto })
  detail(@Param('id') id: string, @Query() _query: EmptyStockQueryDto) { return this.service.detail(id); }
  @Post() @ApiCreatedResponse({ type: IssueResponseDto }) @ApiHeader({ name: 'Idempotency-Key', required: true })
  async create(@CurrentUser() actor: AuthPrincipal, @Body() input: CreateIssueDto, @IdempotencyKey() key: string,
    @Query() _query: EmptyStockQueryDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.service.save(actor.id, input, key); response.status(result.status); return result.body;
  }
  @Patch(':id') @ApiOkResponse({ type: IssueResponseDto }) @ApiHeader({ name: 'Idempotency-Key', required: true })
  async update(@CurrentUser() actor: AuthPrincipal, @Param('id') id: string, @Body() input: UpdateIssueDto, @IdempotencyKey() key: string,
    @Query() _query: EmptyStockQueryDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.service.save(actor.id, input, key, id); response.status(result.status); return result.body;
  }
  @Post(':id/post') @ApiOkResponse({ type: PostedIssueResponseDto }) @ApiHeader({ name: 'Idempotency-Key', required: true })
  async post(@CurrentUser() actor: AuthPrincipal, @Param('id') id: string, @Body() input: PostReceiptDto, @IdempotencyKey() key: string,
    @Query() _query: EmptyStockQueryDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.service.post(actor.id, id, input, key); response.status(result.status); return result.body;
  }
}
