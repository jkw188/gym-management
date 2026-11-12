// Tầng API (US-27 bước 1): Member xem danh mục PT khả dụng và slot trống của một PT.
// Biết ai gọi qua JwtAuthGuard toàn cục; chỉ MEMBER (FixedPermission); chủ thể lấy từ phiên, không nhận từ query.
import { Controller, Get, Param, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { FixedPermission } from '../users/access.policy';
import { AvailabilityService } from './availability.service';
import { PtAvailabilityQueryDto, PtTrainersQueryDto } from './pt-availability.dto';

@Controller('me')
export class PtAvailabilityController {
  constructor(private readonly service: AvailabilityService) {}

  // US-27-TC02: danh mục chỉ có PT khả dụng.
  @Get('pt-trainers')
  @FixedPermission('ptTrainers.readAvailable')
  listTrainers(@Query() query: PtTrainersQueryDto) {
    return this.service.listTrainers(query);
  }

  // US-27-TC01, US-27-TC02, US-27-TC03, US-27-TC04
  @Get('pt-trainers/:id/availability')
  @FixedPermission('ptAvailability.read')
  getAvailability(@CurrentUser() user: AuthPrincipal, @Param('id') id: string, @Query() query: PtAvailabilityQueryDto) {
    return this.service.getAvailability(user.id, id, query);
  }
}
