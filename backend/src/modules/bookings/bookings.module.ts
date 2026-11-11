// Cấu hình NestJS (US-27 bước 1–2, 4; US-28 bước 3): module lịch PT – khai báo API Member xem PT/slot (AvailabilityService),
// lịch PT riêng (MePtBookingsService), đặt slot PT (BookingService, US-28) và hủy buổi PT (CancelBookingService, US-29).
// US-27 đọc ca qua ShiftsModule, lớp qua PublicSessionsModule, gói qua MembershipsModule, chủ thể qua MembersDataModule.
// US-28 BookingService tự đọc members/gói/PT/lớp qua BookingRepository: sau khi giữ khóa phải đọc lại trong CÙNG session
// của transaction (US-28-G04), mà các reader trên không nhận session.
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TransactionModule } from '../../infrastructure/transaction/transaction.module';
import { MembersDataModule } from '../members/members-data.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OperationsModule } from '../operations/operations.module';
import { MembershipsModule } from '../memberships/memberships.module';
import { PublicSessionsModule } from '../public-sessions/public-sessions.module';
import { ShiftsModule } from '../shifts/shifts.module';
import { AvailabilityService } from './availability.service';
import { BookingController } from './booking.controller';
import { BookingRepository } from './booking.repository';
import { BookingService } from './booking.service';
import { CancelBookingService } from './cancel-booking.service';
import { MePtBookingsController } from './me-pt-bookings.controller';
import { MePtBookingsRepository } from './me-pt-bookings.repository';
import { MePtBookingsService } from './me-pt-bookings.service';
import { PtAvailabilityController } from './pt-availability.controller';
import { PtAvailabilityRepository } from './pt-availability.repository';
import { BookingEventSchema } from './schemas/booking-event.schema';
import { PtBookingSchema } from './schemas/pt-booking.schema';

@Module({
  imports: [
    // Cùng schema với MembershipsModule (US-17) nên Mongoose dùng lại một model PtBooking.
    // BookingEvent: audit booking_events của lệnh hủy (US-29 bước 2).
    MongooseModule.forFeature([{ name: 'PtBooking', schema: PtBookingSchema }, { name: 'BookingEvent', schema: BookingEventSchema }]),
    // ShiftIntervalService (slot, overlap, ngày Việt Nam) và ShiftsRepository (ca CONFIRMED).
    ShiftsModule,
    // PublicSessionsRepository: giờ lớp PUBLISHED của PT.
    PublicSessionsModule,
    // MeMembershipsRepository: gói, sale, giao dịch, số buổi BOOKED (US-27-F04).
    MembershipsModule,
    // MemberOwnerReader: account đang đăng nhập → memberId.
    MembersDataModule,
    // IdempotencyService (EN-02): chống đặt lặp theo Idempotency-Key (US-28-TC10).
    OperationsModule,
    // NotificationsService (EN-03): lưu thông báo BOOKING_CREATED cùng transaction đặt lịch (US-28 bước 4).
    NotificationsModule,
    // ServerClock: giờ server; DataGuardsService: khóa lịch và khóa member (US-28-G01, G03);
    // TransactionRunner: transaction của lệnh hủy (US-29).
    TransactionModule,
  ],
  controllers: [PtAvailabilityController, MePtBookingsController, BookingController],
  providers: [AvailabilityService, PtAvailabilityRepository, MePtBookingsService, MePtBookingsRepository, BookingService, BookingRepository,
    // US-29 bước 1: hủy buổi PT dùng chung hai policy OWN/SUPPORT (API thêm ở bước 3).
    CancelBookingService],
})
export class BookingsModule {}
