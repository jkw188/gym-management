// Cấu hình NestJS (US-24 bước 1–2, US-25 bước 1): module ca làm việc PT, khai báo model work_shifts, shift_events,
// controller /api/me/work-shifts, service nghiệp vụ, repository, service thời gian và service chuyển trạng thái ca.
// Export ShiftIntervalService để US-27 (slot) và US-28 (bảo vệ lịch) dùng lại cùng quy tắc; export ShiftsRepository để US-27 đọc ca CONFIRMED.
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TransactionModule } from '../../infrastructure/transaction/transaction.module';
import { OperationsModule } from '../operations/operations.module';
import { ShiftIntervalService } from './shift-interval.service';
import { ShiftTransitionService } from './shift-transition.service';
import { ShiftsController } from './shifts.controller';
import { ShiftsRepository } from './shifts.repository';
import { ShiftsService } from './shifts.service';
import { ShiftEventSchema } from './schemas/shift-event.schema';
import { WorkShiftSchema } from './schemas/work-shift.schema';

@Module({
  imports: [
    // OperationsModule cung cấp IdempotencyService (EN-02) để chống tạo/sửa lặp theo Idempotency-Key.
    OperationsModule,
    // TransactionModule cung cấp DataGuardsService: khóa lịch schedule_guards dùng chung với đặt lịch PT (US-28-G02).
    TransactionModule,
    MongooseModule.forFeature([
      { name: 'WorkShift', schema: WorkShiftSchema },
      { name: 'ShiftEvent', schema: ShiftEventSchema },
    ]),
  ],
  controllers: [ShiftsController],
  providers: [ShiftIntervalService, ShiftTransitionService, ShiftsService, ShiftsRepository],
  exports: [ShiftIntervalService, ShiftsRepository],
})
export class ShiftsModule {}
