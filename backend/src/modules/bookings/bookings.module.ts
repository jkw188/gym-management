// Cấu hình NestJS (US-27 bước 1): module lịch PT – khai báo API Member xem PT/slot, AvailabilityService và repository chỉ đọc.
// Đọc ca qua ShiftsModule, lớp qua PublicSessionsModule, gói qua MembershipsModule, chủ thể qua MembersDataModule.
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TransactionModule } from '../../infrastructure/transaction/transaction.module';
import { MembersDataModule } from '../members/members-data.module';
import { MembershipsModule } from '../memberships/memberships.module';
import { PublicSessionsModule } from '../public-sessions/public-sessions.module';
import { ShiftsModule } from '../shifts/shifts.module';
import { AvailabilityService } from './availability.service';
import { PtAvailabilityController } from './pt-availability.controller';
import { PtAvailabilityRepository } from './pt-availability.repository';
import { PtBookingSchema } from './schemas/pt-booking.schema';

@Module({
  imports: [
    // Cùng schema với MembershipsModule (US-17) nên Mongoose dùng lại một model PtBooking.
    MongooseModule.forFeature([{ name: 'PtBooking', schema: PtBookingSchema }]),
    // ShiftIntervalService (slot, overlap, ngày Việt Nam) và ShiftsRepository (ca CONFIRMED).
    ShiftsModule,
    // PublicSessionsRepository: giờ lớp PUBLISHED của PT.
    PublicSessionsModule,
    // MeMembershipsRepository: gói, sale, giao dịch, số buổi BOOKED.
    MembershipsModule,
    // MemberOwnerReader: account đang đăng nhập → memberId.
    MembersDataModule,
    // ServerClock: giờ server.
    TransactionModule,
  ],
  controllers: [PtAvailabilityController],
  providers: [AvailabilityService, PtAvailabilityRepository],
})
export class BookingsModule {}
