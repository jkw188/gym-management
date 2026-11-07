// Cấu hình NestJS (US-26 bước 1, 2): module lịch lớp miễn phí công khai, khai báo model public_sessions,
// controller /api/public-sessions, service đọc và repository. US-66 sau này thêm phần Admin ghi vào module này.
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ShiftsModule } from '../shifts/shifts.module';
import { PublicSessionQueryService } from './public-session-query.service';
import { PublicSessionsController } from './public-sessions.controller';
import { PublicSessionsRepository } from './public-sessions.repository';
import { PublicSessionSchema } from './schemas/public-session.schema';

// US-26 bước 2: chỉ có MỘT model 'PublicSession' cho collection public_sessions.
// Admin writer (US-66) và trang công khai cùng ghi/đọc model này, không tạo nguồn dữ liệu giả (US-26-TC01).
const publicSessionModel = MongooseModule.forFeature([{ name: 'PublicSession', schema: PublicSessionSchema }]);

@Module({
  imports: [
    // ShiftsModule export ShiftIntervalService: luật đổi ngày Việt Nam sang khoảng UTC dùng chung.
    ShiftsModule,
    publicSessionModel,
  ],
  controllers: [PublicSessionsController],
  providers: [PublicSessionQueryService, PublicSessionsRepository],
  // Export model để module khác (US-66 Admin, US-27/28 loại giờ PT bận) dùng đúng schema và index này.
  exports: [publicSessionModel],
})
export class PublicSessionsModule {}
