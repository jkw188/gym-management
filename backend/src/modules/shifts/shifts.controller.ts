// Tầng API (US-24 bước 2): 4 endpoint /api/me/work-shifts cho PT xem, tạo, sửa ca nháp của chính mình.
// Biết ai gọi qua JwtAuthGuard toàn cục; chỉ TRAINER; PT lấy từ phiên đăng nhập, không nhận từ client (US-24-F01).
import { Body, Controller, Get, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { IdempotencyKey } from '../../common/decorators/idempotency-key.decorator';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { CreateShiftDto, ShiftListQueryDto, UpdateShiftDto } from './shifts.dto';
import { ShiftsService } from './shifts.service';

@Controller('me/work-shifts')
// US-24-TC02: không token → 401 (Guard); MEMBER/STAFF/ADMIN → 403, không làm thay PT.
@Roles('TRAINER')
export class ShiftsController {
  constructor(private readonly shifts: ShiftsService) {}

  @Get()
  list(@CurrentUser() user: AuthPrincipal, @Query() query: ShiftListQueryDto) {
    return this.shifts.listOwn(user.id, query);
  }

  @Get(':id')
  detail(@CurrentUser() user: AuthPrincipal, @Param('id') id: string) {
    return this.shifts.getOwn(user.id, id);
  }

  // passthrough: tự đặt mã HTTP nhưng vẫn để Nest gửi body. Gửi lại cùng key trả đúng mã gốc (201) đã lưu (EN-02).
  @Post()
  async create(@CurrentUser() user: AuthPrincipal, @IdempotencyKey() key: string, @Body() dto: CreateShiftDto,
    @Res({ passthrough: true }) response: Response) {
    const result = await this.shifts.create(user.id, dto, key);
    response.status(result.status);
    return result.body;
  }

  @Patch(':id')
  async update(@CurrentUser() user: AuthPrincipal, @Param('id') id: string, @IdempotencyKey() key: string,
    @Body() dto: UpdateShiftDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.shifts.update(user.id, id, dto, key);
    response.status(result.status);
    return result.body;
  }
}
