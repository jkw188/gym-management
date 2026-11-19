// Cấu hình NestJS (US-40 bước 1–2): module giỏ hàng – model carts, cart_states, resolver chủ giỏ và API /api/me/cart.
// MembersDataModule: MemberOwnerReader (US-17); OperationsModule: Idempotency-Key (EN-02); TransactionModule: transaction và khóa.
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TransactionModule } from '../../infrastructure/transaction/transaction.module';
import { MembersDataModule } from '../members/members-data.module';
import { OperationsModule } from '../operations/operations.module';
import { CartController } from './cart.controller';
import { CartOwnerResolver } from './cart-owner.resolver';
import { CartRepository } from './cart.repository';
import { CartService } from './cart.service';
import { CartSchema } from './schemas/cart.schema';
import { CartStateSchema } from './schemas/cart-state.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: 'Cart', schema: CartSchema },
      { name: 'CartState', schema: CartStateSchema },
    ]),
    MembersDataModule,
    OperationsModule,
    TransactionModule,
  ],
  controllers: [CartController],
  providers: [CartOwnerResolver, CartRepository, CartService],
})
export class CartModule {}
