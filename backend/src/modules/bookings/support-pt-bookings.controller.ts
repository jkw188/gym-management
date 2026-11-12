// Tầng API (US-29 bước 3): GET /api/pt-bookings và GET /api/pt-bookings/:id – Staff/Admin tra cứu lịch PT để hỗ trợ.
// Chỉ STAFF/ADMIN (ptBookings.readSupport); Member và PT → 403 (US-29-TC03, TC06).
import { Controller, Get, Param, Query } from '@nestjs/common';
import { FixedPermission } from '../users/access.policy';
import { SupportPtBookingsQueryDto } from './support-pt-bookings.dto';
import { SupportPtBookingsService } from './support-pt-bookings.service';

@Controller('pt-bookings')
export class SupportPtBookingsController {
  constructor(private readonly service: SupportPtBookingsService) {}

  // US-29-TC05
  @Get()
  @FixedPermission('ptBookings.readSupport')
  list(@Query() query: SupportPtBookingsQueryDto) {
    return this.service.list(query);
  }

  // US-29-TC05
  @Get(':id')
  @FixedPermission('ptBookings.readSupport')
  detail(@Param('id') id: string) {
    return this.service.detail(id);
  }
}
