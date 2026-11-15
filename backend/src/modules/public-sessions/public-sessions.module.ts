// Cấu hình NestJS (US-26 bước 1, 2): module lịch lớp miễn phí công khai, khai báo model public_sessions,
// controller public US-26 và quản trị US-66 dùng chung nguồn public_sessions.
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ShiftsModule } from '../shifts/shifts.module';
import { PublicSessionQueryService } from './public-session-query.service';
import { PublicSessionsController } from './public-sessions.controller';
import { PublicSessionsRepository } from './public-sessions.repository';
import { PublicSessionSchema } from './schemas/public-session.schema';
import { TransactionModule } from '../../infrastructure/transaction/transaction.module';
import { OperationsModule } from '../operations/operations.module';
import { AdminPublicSessionsController } from './admin-public-sessions.controller';
import { AdminPublicSessionsRepository } from './admin-public-sessions.repository';
import { AdminPublicSessionsService } from './admin-public-sessions.service';
import { PublicSessionEventSchema } from './schemas/public-session-event.schema';

@Module({
  imports: [
    // ShiftsModule export ShiftIntervalService: luật đổi ngày Việt Nam sang khoảng UTC dùng chung.
    ShiftsModule,
    TransactionModule,
    OperationsModule,
    // Model chỉ dùng nội bộ module này, không export.
    MongooseModule.forFeature([{ name: 'PublicSession', schema: PublicSessionSchema }, { name: 'PublicSessionEvent', schema: PublicSessionEventSchema }]),
  ],
  controllers: [PublicSessionsController, AdminPublicSessionsController],
  providers: [PublicSessionQueryService, PublicSessionsRepository, AdminPublicSessionsRepository, AdminPublicSessionsService],
  // US-26 bước 2: export repository, không export model. Module khác (US-66 Admin, US-27/28 loại giờ PT bận)
  // đọc/ghi public_sessions qua repository – nơi duy nhất chạm MongoDB – không tạo nguồn dữ liệu giả (US-26-TC01).
  exports: [PublicSessionsRepository],
})
export class PublicSessionsModule {}
