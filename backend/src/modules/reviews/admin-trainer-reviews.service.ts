import { Injectable, Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import { ApplicationError, invalidField } from '../../common/errors/application-error';
import { ServerClock } from '../../common/utils/business-date';
import { TransactionRunner } from '../../infrastructure/transaction/transaction-runner';
import { AdminTrainerReviewDto, AdminTrainerReviewPageDto, AdminTrainerReviewsQueryDto, AdminTrainerSummaryPageDto, ReviewMetricsDto } from './admin-trainer-reviews.dto';
import { AdminReviewRow, AdminTrainerReviewsRepository, ReviewGroup } from './admin-trainer-reviews.repository';
import { toTrainerReviewView } from './review.mapper';
import { reviewPeriod } from './review-period';

const metrics = (row?: ReviewGroup): ReviewMetricsDto => ({
  reviewCount: row?.reviewCount ?? 0, ratingSum: row?.ratingSum ?? 0,
  averageRating: row?.reviewCount ? row.ratingSum / row.reviewCount : null,
  distribution: { '1': row?.star1 ?? 0, '2': row?.star2 ?? 0, '3': row?.star3 ?? 0, '4': row?.star4 ?? 0, '5': row?.star5 ?? 0 },
});
const reviewView = (row: AdminReviewRow): AdminTrainerReviewDto => ({
  ...toTrainerReviewView({ ...row, comment: row.comment ?? '' }),
  trainerId: row.trainer_id.toHexString(), trainerNameSnapshot: row.trainer_name_snapshot ?? '',
});

@Injectable()
export class AdminTrainerReviewsService {
  private readonly logger = new Logger(AdminTrainerReviewsService.name);
  constructor(private readonly repository: AdminTrainerReviewsRepository, private readonly transactions: TransactionRunner, private readonly clock: ServerClock) {}

  summary(query: AdminTrainerReviewsQueryDto): Promise<AdminTrainerSummaryPageDto> { return this.read(query, true); }
  list(query: AdminTrainerReviewsQueryDto): Promise<AdminTrainerReviewPageDto> { return this.read(query, false); }

  private read(query: AdminTrainerReviewsQueryDto, summary: true): Promise<AdminTrainerSummaryPageDto>;
  private read(query: AdminTrainerReviewsQueryDto, summary: false): Promise<AdminTrainerReviewPageDto>;
  private async read(query: AdminTrainerReviewsQueryDto, summary: boolean) {
    const range = reviewPeriod(this.clock.today(), query.fromDate, query.toDate);
    if (!Number.isSafeInteger(query.page * query.limit)) invalidField('page', 'Trang vượt giới hạn cho phép');
    const trainerId = query.trainerId ? new Types.ObjectId(query.trainerId) : undefined;
    const { response, invalid } = await this.transactions.run(async session => {
      const asOf = this.clock.now().toISOString();
      const data = await this.repository.page({ ...range, ...query, trainerId }, session, !summary);
      const totals = metrics();
      for (const row of data.groups) {
        totals.reviewCount += row.reviewCount; totals.ratingSum += row.ratingSum;
        const distribution = metrics(row).distribution;
        for (const star of Object.keys(distribution)) totals.distribution[star] += distribution[star];
      }
      totals.averageRating = totals.reviewCount ? totals.ratingSum / totals.reviewCount : null;
      const common = { page: query.page, limit: query.limit, asOf, range: { fromDate: range.fromDate, toDate: range.toDate },
        totals, invalidReviewCount: data.invalid.length };
      if (!summary) {
        const total = data.counts[0]?.total ?? 0;
        return { response: { ...common, items: data.items.map(reviewView), total, totalPages: Math.ceil(total / query.limit) }, invalid: data.invalid };
      }
      const trainers = await this.repository.trainers(session, trainerId);
      const groups = new Map(data.groups.map(row => [row._id.toHexString(), row]));
      const items = trainers.slice((query.page - 1) * query.limit, query.page * query.limit).map(trainer => ({
        trainerId: trainer._id.toHexString(), currentTrainerName: trainer.currentTrainerName ?? '', status: trainer.status ?? null,
        ...metrics(groups.get(trainer._id.toHexString())),
      }));
      return { response: { ...common, items, total: trainers.length, totalPages: Math.ceil(trainers.length / query.limit) }, invalid: data.invalid };
    });
    // Chỉ ID, không log comment/thông tin cá nhân. Ngoài callback để retry transaction không log lặp.
    for (const row of invalid) this.logger.warn({ code: 'INVALID_TRAINER_REVIEW', reviewId: String(row._id) });
    return response;
  }

  detail(id: string): Promise<AdminTrainerReviewDto & { asOf: string }> {
    return this.transactions.run(async session => {
      const asOf = this.clock.now().toISOString();
      const row = await this.repository.detail(new Types.ObjectId(id), session);
      if (!row) throw new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy đánh giá');
      return { ...reviewView(row), asOf };
    });
  }
}
