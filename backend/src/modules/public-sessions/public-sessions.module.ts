// Cấu hình NestJS (US-26 bước 1, 2): module lịch lớp miễn phí công khai, khai báo model public_sessions,
// controller /api/public-sessions, service đọc và repository. US-66 sau này thêm phần Admin ghi vào module này.
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ShiftsModule } from '../shifts/shifts.module';
import { PublicSessionQueryService } from './public-session-query.service';
import { PublicSessionsController } from './public-sessions.controller';
import { PublicSessionsRepository } from './public-sessions.repository';
import { PublicSessionSchema } from './schemas/public-session.schema';

@Module({
  imports: [
    // ShiftsModule export ShiftIntervalService: luật đổi ngày Việt Nam sang khoảng UTC dùng chung.
    ShiftsModule,
    // Model chỉ dùng nội bộ module này, không export.
    MongooseModule.forFeature([{ name: 'PublicSession', schema: PublicSessionSchema }]),
  ],
  controllers: [PublicSessionsController],
  providers: [PublicSessionQueryService, PublicSessionsRepository],
  // US-26 bước 2: export repository, không export model. Module khác (US-66 Admin, US-27/28 loại giờ PT bận)
  // đọc/ghi public_sessions qua repository – nơi duy nhất chạm MongoDB – không tạo nguồn dữ liệu giả (US-26-TC01).
  exports: [PublicSessionsRepository],
})
export class PublicSessionsModule {}
