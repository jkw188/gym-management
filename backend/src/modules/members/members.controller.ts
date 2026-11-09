import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { IdempotencyKey } from '../../common/decorators/idempotency-key.decorator';
import { ErrorResponseDto } from '../../common/http/error.dto';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { CreateMemberDto, LinkCandidatesQueryDto, LinkCandidatesResponseDto, LinkMemberDto, LinkMemberResponseDto, MemberDto } from './members.dto';
import { MembersService } from './members.service';

@ApiTags('members') @ApiBearerAuth() @Roles('STAFF', 'ADMIN')
@ApiResponse({ status: 400, type: ErrorResponseDto }) @ApiResponse({ status: 401, type: ErrorResponseDto })
@ApiResponse({ status: 403, type: ErrorResponseDto }) @ApiResponse({ status: 404, type: ErrorResponseDto })
@ApiResponse({ status: 409, type: ErrorResponseDto }) @ApiResponse({ status: 503, type: ErrorResponseDto })
@Controller('members')
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get('link-candidates') @ApiOkResponse({ type: LinkCandidatesResponseDto })
  candidates(@Query() query: LinkCandidatesQueryDto) { return this.members.linkCandidates(query.phone); }

  @Post() @ApiCreatedResponse({ type: MemberDto }) @ApiHeader({ name: 'Idempotency-Key', required: true })
  async create(@CurrentUser() actor: AuthPrincipal, @Body() input: CreateMemberDto, @IdempotencyKey() key: string,
    @Res({ passthrough: true }) response: Response) {
    const result = await this.members.create(actor, input, key);
    response.status(result.status);
    return result.body;
  }

  @Post(':id/link') @ApiOkResponse({ type: LinkMemberResponseDto }) @ApiHeader({ name: 'Idempotency-Key', required: true })
  async link(@CurrentUser() actor: AuthPrincipal, @Param('id') id: string, @Body() input: LinkMemberDto,
    @IdempotencyKey() key: string, @Res({ passthrough: true }) response: Response) {
    const result = await this.members.link(actor, id, input, key);
    response.status(result.status);
    return result.body;
  }
}
