// Tầng API (US-17 bước 1): 6 endpoint cá nhân /api/me/* để Member xem gói, lần mua, giao dịch, chứng từ của mình.
// Biết ai gọi qua JwtAuthGuard toàn cục; chỉ MEMBER (FixedPermission); accountId lấy từ phiên, không nhận từ query (US-17-F01).
import { Controller, Get, Param, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { FixedPermission } from '../users/access.policy';
import { MeListQueryDto, MeMembershipsQueryDto } from './me-memberships.dto';
import { MeMembershipsService } from './me-memberships.service';

// US-17-TC04: không token/LOCKED/revoked/auth_version đổi → 401 (Guard); TRAINER/STAFF/ADMIN → 403.
@Controller('me')
export class MeMembershipsController {
  constructor(private readonly service: MeMembershipsService) {}

  // US-17-TC01, US-17-TC02, US-17-TC03
  @Get('memberships')
  @FixedPermission('memberships.readOwn')
  listMemberships(@CurrentUser() user: AuthPrincipal, @Query() query: MeMembershipsQueryDto) {
    return this.service.listMemberships(user.id, query);
  }

  @Get('memberships/:id')
  @FixedPermission('memberships.readOwn')
  getMembership(@CurrentUser() user: AuthPrincipal, @Param('id') id: string) {
    return this.service.getMembership(user.id, id);
  }

  @Get('service-sales')
  @FixedPermission('serviceSales.readOwn')
  listServiceSales(@CurrentUser() user: AuthPrincipal, @Query() query: MeListQueryDto) {
    return this.service.listServiceSales(user.id, query);
  }

  @Get('service-sales/:id')
  @FixedPermission('serviceSales.readOwn')
  getServiceSale(@CurrentUser() user: AuthPrincipal, @Param('id') id: string) {
    return this.service.getServiceSale(user.id, id);
  }

  @Get('transactions/:id')
  @FixedPermission('transactions.readOwn')
  getTransaction(@CurrentUser() user: AuthPrincipal, @Param('id') id: string) {
    return this.service.getTransaction(user.id, id);
  }

  @Get('invoices/:id')
  @FixedPermission('invoices.readOwn')
  getInvoice(@CurrentUser() user: AuthPrincipal, @Param('id') id: string) {
    return this.service.getInvoice(user.id, id);
  }
}
