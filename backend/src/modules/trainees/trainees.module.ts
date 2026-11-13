// Cấu hình NestJS (US-30 bước 1–2): module học viên của PT – khai báo API /api/me/trainees, service và repository chỉ đọc.
// Dùng chung schema pt_bookings với BookingsModule nên Mongoose dùng lại một model PtBooking.
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TransactionModule } from '../../infrastructure/transaction/transaction.module';
import { PtBookingSchema } from '../bookings/schemas/pt-booking.schema';
import { MembershipsModule } from '../memberships/memberships.module';
import { ShiftsModule } from '../shifts/shifts.module';
import { TraineesController } from './trainees.controller';
import { TraineesRepository } from './trainees.repository';
import { TraineeQueryService } from './trainees.service';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: 'PtBooking', schema: PtBookingSchema }]),
    // ServerClock: giờ server để biết buổi nào "sắp tới" và thời điểm asOf.
    TransactionModule,
    // US-30 bước 2: ShiftIntervalService – đổi ngày VN thành khoảng UTC cho lịch học viên.
    ShiftsModule,
    // US-30 bước 2: MeMembershipsRepository – nguồn quota chung của US-17 (gói, sale, giao dịch, đếm BOOKED).
    MembershipsModule,
  ],
  controllers: [TraineesController],
  providers: [TraineeQueryService, TraineesRepository],
})
export class TraineesModule {}
