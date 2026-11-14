// Cấu hình NestJS (US-65 bước 1–2): module đánh giá buổi PT – collection trainer_reviews và API Member gửi/xem đánh giá.
// BookingsModule: đọc booking, ghi audit; OperationsModule: Idempotency-Key (EN-02); TransactionModule: khóa và giờ server.
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TransactionModule } from '../../infrastructure/transaction/transaction.module';
import { BookingsModule } from '../bookings/bookings.module';
import { OperationsModule } from '../operations/operations.module';
import { ReviewController } from './review.controller';
import { ReviewRepository } from './review.repository';
import { ReviewService } from './review.service';
import { TrainerReviewSchema } from './schemas/trainer-review.schema';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: 'TrainerReview', schema: TrainerReviewSchema }]),
    BookingsModule,
    OperationsModule,
    TransactionModule,
  ],
  controllers: [ReviewController],
  providers: [ReviewService, ReviewRepository],
})
export class ReviewsModule {}
