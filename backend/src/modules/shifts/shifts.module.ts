// Cấu hình NestJS (US-24 bước 1–2): module ca làm việc PT, khai báo model work_shifts, shift_events,
// controller /api/me/work-shifts, service nghiệp vụ, repository và service thời gian dùng chung.
// Export ShiftIntervalService để US-27 (slot) và US-28 (bảo vệ lịch) dùng lại cùng quy tắc.
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { OperationsModule } from '../operations/operations.module';
import { ShiftIntervalService } from './shift-interval.service';
import { ShiftsController } from './shifts.controller';
import { ShiftsRepository } from './shifts.repository';
import { ShiftsService } from './shifts.service';
import { ShiftEventSchema } from './schemas/shift-event.schema';
import { WorkShiftSchema } from './schemas/work-shift.schema';

@Module({
  imports: [
    // OperationsModule cung cấp IdempotencyService (EN-02) để chống tạo/sửa lặp theo Idempotency-Key.
    OperationsModule,
    MongooseModule.forFeature([
      { name: 'WorkShift', schema: WorkShiftSchema },
      { name: 'ShiftEvent', schema: ShiftEventSchema },
    ]),
  ],
  controllers: [ShiftsController],
  providers: [ShiftIntervalService, ShiftsService, ShiftsRepository],
  exports: [ShiftIntervalService],
})
export class ShiftsModule {}
