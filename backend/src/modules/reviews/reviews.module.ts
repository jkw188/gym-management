// Cấu hình NestJS (US-65 bước 1–2, US-31 bước 1): module đánh giá buổi PT – collection trainer_reviews, API Member gửi/xem và API PT xem đánh giá.
// BookingsModule: đọc booking, ghi audit; OperationsModule: Idempotency-Key (EN-02); TransactionModule: khóa và giờ server.
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TransactionModule } from '../../infrastructure/transaction/transaction.module';
import { BookingsModule } from '../bookings/bookings.module';
import { OperationsModule } from '../operations/operations.module';
import { ReviewController } from './review.controller';
import { ReviewRepository } from './review.repository';
import { ReviewService } from './review.service';
import { TrainerReviewQueryController } from './trainer-review-query.controller';
import { TrainerReviewQueryService } from './trainer-review-query.service';
import { TrainerReviewSchema } from './schemas/trainer-review.schema';
import { AdminTrainerReviewsController } from './admin-trainer-reviews.controller';
import { AdminTrainerReviewsService } from './admin-trainer-reviews.service';
import { AdminTrainerReviewsRepository } from './admin-trainer-reviews.repository';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: 'TrainerReview', schema: TrainerReviewSchema }]),
    BookingsModule,
    OperationsModule,
    TransactionModule,
  ],
  controllers: [ReviewController, TrainerReviewQueryController, AdminTrainerReviewsController],
  providers: [ReviewService, ReviewRepository, TrainerReviewQueryService, AdminTrainerReviewsService, AdminTrainerReviewsRepository],
})
export class ReviewsModule {}
