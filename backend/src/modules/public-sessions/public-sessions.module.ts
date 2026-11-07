// Cấu hình NestJS (US-26 bước 1): module lịch lớp miễn phí công khai, khai báo model public_sessions,
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
    MongooseModule.forFeature([{ name: 'PublicSession', schema: PublicSessionSchema }]),
  ],
  controllers: [PublicSessionsController],
  providers: [PublicSessionQueryService, PublicSessionsRepository],
})
export class PublicSessionsModule {}
