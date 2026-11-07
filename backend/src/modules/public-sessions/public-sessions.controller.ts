// Tầng API (US-26 bước 1): 3 endpoint công khai xem lịch lớp miễn phí, KHÔNG cần đăng nhập.
// @Public() bỏ qua JwtAuthGuard toàn cục; có token cũng trả như Guest vì service không dùng thông tin người gọi (US-26-TC03).
import { Controller, Get, Param, Query } from '@nestjs/common';
import { Public } from '../auth/auth.decorators';
import { PublicSessionQueryDto } from './public-sessions.dto';
import { PublicSessionQueryService } from './public-session-query.service';

@Controller()
@Public()
export class PublicSessionsController {
  constructor(private readonly sessions: PublicSessionQueryService) {}

  @Get('public-session-subjects')
  subjects() {
    return this.sessions.listSubjects();
  }

  @Get('public-sessions')
  list(@Query() query: PublicSessionQueryDto) {
    return this.sessions.list(query);
  }

  @Get('public-sessions/:id')
  detail(@Param('id') id: string) {
    return this.sessions.detail(id);
  }
}
