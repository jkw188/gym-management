// Tầng API (US-09 bước 1–3): POST /api/members tạo hồ sơ, GET /api/members/link-candidates tra account và
// POST /api/members/:id/link liên kết hồ sơ với account; chỉ cho Staff/Admin.
// Biết ai gọi qua JwtAuthGuard toàn cục; người tạo lấy từ phiên đăng nhập, không nhận từ client.
import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { IdempotencyKey } from '../../common/decorators/idempotency-key.decorator';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { CreateMemberDto, LinkCandidatesQueryDto, LinkMemberDto } from './members.dto';
import { MembersService } from './members.service';

@Controller('members')
// US-09-TC02: không token/phiên thu hồi/tài khoản khóa → 401 (Guard); MEMBER/TRAINER → 403.
@Roles('STAFF', 'ADMIN')
export class MembersController {
  constructor(private readonly members: MembersService) {}

  // passthrough: tự đặt mã HTTP nhưng vẫn để Nest gửi body. Gửi lại cùng key trả đúng mã gốc 201 (US-09-TC06).
  @Post()
  async create(@CurrentUser() user: AuthPrincipal, @IdempotencyKey() key: string, @Body() dto: CreateMemberDto,
    @Res({ passthrough: true }) response: Response) {
    const result = await this.members.create(user.id, dto, key);
    response.status(result.status);
    return result.body;
  }

  // US-09 bước 2: tra account theo đúng số phone. Staff dùng route này, không dùng GET /api/users của Admin (US-09-TC02).
  @Get('link-candidates')
  linkCandidates(@Query() query: LinkCandidatesQueryDto) {
    return this.members.findLinkCandidates(query.phone);
  }

  // US-09 bước 3: liên kết hồ sơ với account sau xác minh tại quầy. Trả 200; gửi lại cùng key trả đúng kết quả gốc.
  @Post(':id/link')
  async link(@CurrentUser() user: AuthPrincipal, @Param('id') id: string, @IdempotencyKey() key: string,
    @Body() dto: LinkMemberDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.members.link(user, id, dto, key);
    response.status(result.status);
    return result.body;
  }
}
