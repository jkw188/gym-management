import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { DatabaseModule } from './config/database.module';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { MembersModule } from './modules/members/members.module';
import { MembershipsModule } from './modules/memberships/memberships.module';
import { TrainersModule } from './modules/trainers/trainers.module';
import { BookingsModule } from './modules/bookings/bookings.module';
import { WorkoutsModule } from './modules/workouts/workouts.module';
import { ProductsModule } from './modules/products/products.module';
import { OrdersModule } from './modules/orders/orders.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ReportsModule } from './modules/reports/reports.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    DatabaseModule,
    HealthModule,
    AuthModule,
    UsersModule,
    MembersModule,
    MembershipsModule,
    TrainersModule,
    BookingsModule,
    WorkoutsModule,
    ProductsModule,
    OrdersModule,
    InventoryModule,
    PaymentsModule,
    NotificationsModule,
    ReportsModule,
  ],
})
export class AppModule {}
