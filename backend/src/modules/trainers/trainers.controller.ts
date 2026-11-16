import { Body, Controller, Get, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { IdempotencyKey } from '../../common/decorators/idempotency-key.decorator';
import { ErrorResponseDto } from '../../common/http/error.dto';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { FixedPermission } from '../users/access.policy';
import { CreateTrainerDto, EmptyTrainerQueryDto, TrainerBlockerPageDto, TrainerBlockerQueryDto, TrainerDetailDto,
  TrainerListQueryDto, TrainerPageDto, UpdateTrainerDto } from './trainers.dto';
import { TrainersService } from './trainers.service';

@ApiTags('trainers') @ApiBearerAuth()
@ApiResponse({ status: 400, type: ErrorResponseDto }) @ApiResponse({ status: 401, type: ErrorResponseDto })
@ApiResponse({ status: 403, type: ErrorResponseDto }) @ApiResponse({ status: 404, type: ErrorResponseDto })
@ApiResponse({ status: 409, type: ErrorResponseDto }) @ApiResponse({ status: 503, type: ErrorResponseDto })
@Controller('trainers') @FixedPermission('trainers.manage')
export class TrainersController {
  constructor(private readonly trainers: TrainersService) {}
  @Get() @ApiOperation({ summary: 'Danh sách hồ sơ PT (Admin)' }) @ApiOkResponse({ type: TrainerPageDto })
  list(@Query() query: TrainerListQueryDto) { return this.trainers.list(query); }
  @Get(':id/deactivation-blockers') @ApiOperation({ summary: 'Các lịch chặn ngừng hoạt động PT' }) @ApiOkResponse({ type: TrainerBlockerPageDto })
  blockers(@Param('id') id: string, @Query() query: TrainerBlockerQueryDto) { return this.trainers.blockers(id, query); }
  @Get(':id') @ApiOperation({ summary: 'Chi tiết hồ sơ PT và liên hệ từ account' }) @ApiOkResponse({ type: TrainerDetailDto })
  detail(@Param('id') id: string, @Query() _query: EmptyTrainerQueryDto) { return this.trainers.detail(id); }
  @Post() @ApiHeader({ name: 'Idempotency-Key', required: true }) @ApiCreatedResponse({ type: TrainerDetailDto })
  async create(@CurrentUser() actor: AuthPrincipal, @Body() input: CreateTrainerDto, @IdempotencyKey() key: string,
    @Res({ passthrough: true }) response: Response) {
    const result = await this.trainers.create(actor.id, input, key);
    response.status(result.status); return result.body;
  }
  @Patch(':id') @ApiHeader({ name: 'Idempotency-Key', required: true }) @ApiOkResponse({ type: TrainerDetailDto })
  async update(@CurrentUser() actor: AuthPrincipal, @Param('id') id: string, @Body() input: UpdateTrainerDto,
    @IdempotencyKey() key: string, @Res({ passthrough: true }) response: Response) {
    const result = await this.trainers.update(actor.id, id, input, key);
    response.status(result.status); return result.body;
  }
}
