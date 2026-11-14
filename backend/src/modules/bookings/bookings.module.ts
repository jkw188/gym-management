// Cấu hình NestJS (US-27 bước 1–2, 4; US-28 bước 3): module lịch PT – khai báo API Member xem PT/slot (AvailabilityService),
// lịch PT riêng (MePtBookingsService), đặt slot PT (BookingService, US-28), hủy buổi PT (CancelBookingService, US-29)
// và tra cứu lịch PT hỗ trợ cho Staff/Admin (SupportPtBookingsService, US-29 bước 3), PT xác nhận buổi đã dạy (CompleteBookingService, US-64).
// US-27 đọc ca qua ShiftsModule, lớp qua PublicSessionsModule, gói qua MembershipsModule, chủ thể qua MembersDataModule.
// US-28 BookingService tự đọc members/gói/PT/lớp qua BookingRepository: sau khi giữ khóa phải đọc lại trong CÙNG session
// của transaction (US-28-G04), mà các reader trên không nhận session.
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TrainerReviewSchema } from '../reviews/schemas/trainer-review.schema';
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
import { AdminPtBookingsController } from './admin-pt-bookings.controller';
import { CompleteBookingService } from './complete-booking.service';
import { CorrectBookingService } from './correct-booking.service';
import { MePtBookingsController } from './me-pt-bookings.controller';
import { MePtBookingsRepository } from './me-pt-bookings.repository';
import { MePtBookingsService } from './me-pt-bookings.service';
import { PtAvailabilityController } from './pt-availability.controller';
import { PtAvailabilityRepository } from './pt-availability.repository';
import { PtBookingCancelController } from './pt-booking-cancel.controller';
import { PtBookingCompleteController } from './pt-booking-complete.controller';
import { BookingEventSchema } from './schemas/booking-event.schema';
import { PtBookingSchema } from './schemas/pt-booking.schema';
import { SupportPtBookingsController } from './support-pt-bookings.controller';
import { SupportPtBookingsRepository } from './support-pt-bookings.repository';
import { SupportPtBookingsService } from './support-pt-bookings.service';
import { TrainerBookingsController } from './trainer-bookings.controller';
import { TrainerBookingsRepository } from './trainer-bookings.repository';
import { TrainerBookingsService } from './trainer-bookings.service';

@Module({
  imports: [
    // Cùng schema với MembershipsModule (US-17) nên Mongoose dùng lại một model PtBooking.
    // BookingEvent: audit booking_events của lệnh hủy (US-29 bước 2).
    // TrainerReview (US-65 bước 3): lịch riêng của Member đọc review đã gửi để tính reviewState; cùng schema với ReviewsModule.
    MongooseModule.forFeature([{ name: 'PtBooking', schema: PtBookingSchema }, { name: 'BookingEvent', schema: BookingEventSchema },
      { name: 'TrainerReview', schema: TrainerReviewSchema }]),
    // ShiftIntervalService (slot, overlap, ngày Việt Nam) và ShiftsRepository (ca CONFIRMED).
    ShiftsModule,
    // PublicSessionsRepository: giờ lớp PUBLISHED của PT.
    PublicSessionsModule,
    // MeMembershipsRepository: gói, sale, giao dịch, số buổi BOOKED (US-27-F04).
    MembershipsModule,
    // MemberOwnerReader: account đang đăng nhập → memberId.
    MembersDataModule,
    // IdempotencyService (EN-02): chống đặt/hủy lặp theo Idempotency-Key (US-28-TC10, US-29-TC09).
    OperationsModule,
    // NotificationsService (EN-03): lưu thông báo BOOKING_CREATED cùng transaction đặt lịch (US-28 bước 4).
    NotificationsModule,
    // ServerClock: giờ server; DataGuardsService: khóa lịch và khóa member (US-28-G01, G03).
    TransactionModule,
  ],
  // US-29 bước 3: PtBookingCancelController (hủy own/support), SupportPtBookingsController (tra cứu hỗ trợ).
  controllers: [PtAvailabilityController, MePtBookingsController, BookingController, PtBookingCancelController, SupportPtBookingsController,
    // US-64 bước 2: PT xác nhận buổi đã dạy.
    PtBookingCompleteController,
    // US-64 bước 3: Admin xử lý sai và xem chi tiết kèm lịch sử hoàn tất.
    AdminPtBookingsController,
    // US-64 bước 4: PT xem buổi dạy của mình.
    TrainerBookingsController],
  providers: [AvailabilityService, PtAvailabilityRepository, MePtBookingsService, MePtBookingsRepository, BookingService, BookingRepository,
    // US-29: hủy buổi PT dùng chung hai policy OWN/SUPPORT; tra cứu hỗ trợ cho Staff/Admin.
    CancelBookingService, SupportPtBookingsService, SupportPtBookingsRepository,
    // US-64: PT xác nhận buổi đã dạy, trừ đúng một buổi của gói.
    CompleteBookingService,
    // US-64 bước 3: Admin xác nhận hỗ trợ / rút xác nhận sai.
    CorrectBookingService,
    // US-64 bước 4: danh sách buổi dạy của PT.
    TrainerBookingsService, TrainerBookingsRepository],
  // US-65 bước 2: ReviewsModule dùng BookingRepository đọc booking và ghi audit REVIEW_SUBMITTED vào booking_events.
  exports: [BookingRepository],
})
export class BookingsModule {}
