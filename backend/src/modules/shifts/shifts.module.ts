// Cấu hình NestJS (US-24 bước 1): module ca làm việc PT, khai báo model work_shifts, shift_events và service thời gian dùng chung.
// Export ShiftIntervalService để US-27 (slot) và US-28 (bảo vệ lịch) dùng lại cùng quy tắc.
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ShiftIntervalService } from './shift-interval.service';
import { ShiftEventSchema } from './schemas/shift-event.schema';
import { WorkShiftSchema } from './schemas/work-shift.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: 'WorkShift', schema: WorkShiftSchema },
      { name: 'ShiftEvent', schema: ShiftEventSchema },
    ]),
  ],
  providers: [ShiftIntervalService],
  exports: [ShiftIntervalService],
})
export class ShiftsModule {}
