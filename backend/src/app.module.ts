import { ReturnsModule } from './modules/returns/returns.module';
import { RemindersModule } from './modules/reminders/reminders.module';
import { Module } from '@nestjs/common';
import { AttendanceModule } from './modules/attendance/attendance.module';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { DatabaseModule } from './config/database.module';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { ProfileModule } from './modules/profile/profile.module';
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
import { OperationsModule } from './modules/operations/operations.module';
import { ShiftsModule } from './modules/shifts/shifts.module';
import { PublicSessionsModule } from './modules/public-sessions/public-sessions.module';
import { SalesModule } from './modules/sales/sales.module';
import { PlansModule } from './modules/plans/plans.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { TraineesModule } from './modules/trainees/trainees.module';
import { ReviewsModule } from './modules/reviews/reviews.module';
import { StockModule } from './modules/stock/stock.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: process.env.DEPLOYMENT_ENV === 'uat', load: [configuration] }),
    DatabaseModule,
    HealthModule,
    AuthModule,
    UsersModule,
    ProfileModule,
    MembersModule,
    MembershipsModule,
    TrainersModule,
    BookingsModule,
    WorkoutsModule,
    ProductsModule,
    OrdersModule,
    ReturnsModule,
    InventoryModule,
    StockModule,
    PaymentsModule,
    NotificationsModule,
    RemindersModule,
    ReportsModule,
    OperationsModule,
    ShiftsModule,
    AttendanceModule,
    PublicSessionsModule,
    SalesModule,
    PlansModule,
    CatalogModule,
    TraineesModule,
    ReviewsModule,
  ],
})
export class AppModule {}
