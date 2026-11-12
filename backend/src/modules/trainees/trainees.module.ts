// Cấu hình NestJS (US-30 bước 1): module học viên của PT – khai báo API /api/me/trainees, service và repository chỉ đọc.
// Dùng chung schema pt_bookings với BookingsModule nên Mongoose dùng lại một model PtBooking.
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TransactionModule } from '../../infrastructure/transaction/transaction.module';
import { PtBookingSchema } from '../bookings/schemas/pt-booking.schema';
import { TraineesController } from './trainees.controller';
import { TraineesRepository } from './trainees.repository';
import { TraineeQueryService } from './trainees.service';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: 'PtBooking', schema: PtBookingSchema }]),
    // ServerClock: giờ server để biết buổi nào "sắp tới".
    TransactionModule,
  ],
  controllers: [TraineesController],
  providers: [TraineeQueryService, TraineesRepository],
})
export class TraineesModule {}
