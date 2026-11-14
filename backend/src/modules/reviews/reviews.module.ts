// Cấu hình NestJS (US-65 bước 1): module đánh giá buổi PT – hiện chỉ khai báo collection trainer_reviews.
// Bước 2 sẽ thêm controller, service, repository gửi/đọc đánh giá vào đây.
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TrainerReviewSchema } from './schemas/trainer-review.schema';

@Module({
  imports: [MongooseModule.forFeature([{ name: 'TrainerReview', schema: TrainerReviewSchema }])],
})
export class ReviewsModule {}
