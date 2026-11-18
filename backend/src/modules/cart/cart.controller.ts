// Tầng API (US-40 bước 2): Member xem giỏ, thêm, đặt số lượng và xóa dòng giỏ của chính mình.
// Người gọi lấy từ phiên đăng nhập (JwtAuthGuard toàn cục); FixedPermission chặn PT/Staff/Admin bằng 403 (US-40-TC02).
import { Body, Controller, Delete, Get, Header, Param, Post, Put, Query } from '@nestjs/common';
import { IdempotencyKey } from '../../common/decorators/idempotency-key.decorator';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { FixedPermission } from '../users/access.policy';
import { AddCartItemDto, CartItemParamDto, RemoveCartItemQueryDto, SetCartItemDto } from './cart.dto';
import { CartService } from './cart.service';

@Controller('me/cart')
export class CartController {
  constructor(private readonly cart: CartService) {}

  // US-40-TC01, TC03: no-store để luôn thấy giá/tồn mới nhất.
  @Get()
  @FixedPermission('cart.readOwn')
  @Header('Cache-Control', 'no-store')
  get(@CurrentUser() user: AuthPrincipal) {
    return this.cart.getCart(user.id);
  }

  // US-40-TC01: 201 (mặc định của POST trong Nest).
  @Post('items')
  @FixedPermission('cart.writeOwn')
  add(@CurrentUser() user: AuthPrincipal, @IdempotencyKey() key: string, @Body() dto: AddCartItemDto) {
    return this.cart.addItem(user.id, key, dto);
  }

  @Put('items/:productId')
  @FixedPermission('cart.writeOwn')
  set(@CurrentUser() user: AuthPrincipal, @Param() params: CartItemParamDto, @IdempotencyKey() key: string, @Body() dto: SetCartItemDto) {
    return this.cart.setItem(user.id, key, params.productId, dto);
  }

  @Delete('items/:productId')
  @FixedPermission('cart.writeOwn')
  remove(@CurrentUser() user: AuthPrincipal, @Param() params: CartItemParamDto, @IdempotencyKey() key: string,
    @Query() query: RemoveCartItemQueryDto) {
    return this.cart.removeItem(user.id, key, params.productId, query.version);
  }
}
