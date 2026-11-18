// Cấu hình NestJS (US-40 bước 1): module giỏ hàng – model carts, cart_states và resolver chủ giỏ.
// MembersDataModule cung cấp MemberOwnerReader (US-17). Controller/service/repository sẽ thêm ở bước 2.
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MembersDataModule } from '../members/members-data.module';
import { CartOwnerResolver } from './cart-owner.resolver';
import { CartSchema } from './schemas/cart.schema';
import { CartStateSchema } from './schemas/cart-state.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: 'Cart', schema: CartSchema },
      { name: 'CartState', schema: CartStateSchema },
    ]),
    MembersDataModule,
  ],
  providers: [CartOwnerResolver],
})
export class CartModule {}
