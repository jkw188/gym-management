import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession } from 'mongodb';
import { Connection, Model, PipelineStage, Types } from 'mongoose';
import { TrainerReview } from './schemas/trainer-review.schema';
import { TrainerReviewRow } from './review.types';

export interface AdminReviewFilter { trainerId?: Types.ObjectId; from: Date; to: Date; rating?: number; page: number; limit: number }
export interface AdminReviewRow extends TrainerReviewRow { trainer_id: Types.ObjectId; trainer_name_snapshot?: string }
export interface ReviewGroup { _id: Types.ObjectId; reviewCount: number; ratingSum: number; star1: number; star2: number; star3: number; star4: number; star5: number }
export interface ReviewFacet { groups: ReviewGroup[]; invalid: { _id: Types.ObjectId }[]; items: AdminReviewRow[]; counts: { total: number }[] }
export interface ReviewTrainer { _id: Types.ObjectId; currentTrainerName?: string; status?: string }

const projection: PipelineStage.Project = { $project: {
  _id: 1, trainer_id: 1, trainer_name_snapshot: 1, member_display_name_snapshot: 1,
  rating: 1, comment: 1, created_at: 1, 'booking._id': 1, 'booking.start_at': 1, 'booking.end_at': 1,
} };

// Không unwind nguồn thiếu: giữ lại để đếm và log ID review lỗi, không đoán chủ hay chữa dữ liệu khi GET.
function sourceStages(): PipelineStage[] {
  const lookup = (from: string, localField: string, as: string, fields: Record<string, number>): PipelineStage => ({ $lookup: {
    from, localField, foreignField: '_id', pipeline: [{ $project: fields }], as,
  } });
  return [
    lookup('pt_bookings', 'booking_id', 'booking', { _id: 1, trainer_id: 1, member_id: 1, status: 1, start_at: 1, end_at: 1 }),
    lookup('trainers', 'trainer_id', 'trainer', { _id: 1 }),
    lookup('members', 'member_id', 'member', { _id: 1 }),
    { $set: { booking: { $first: '$booking' } } },
    { $set: { valid: { $and: [
      ...['_id', 'trainer_id', 'member_id', 'booking_id'].map(field => ({ $eq: [{ $type: `$${field}` }, 'objectId'] })),
      { $in: ['$rating', [1, 2, 3, 4, 5]] },
      { $eq: [{ $size: '$trainer' }, 1] }, { $eq: [{ $size: '$member' }, 1] },
      { $eq: ['$booking.status', 'COMPLETED'] },
      { $eq: ['$booking.trainer_id', '$trainer_id'] }, { $eq: ['$booking.member_id', '$member_id'] },
      { $eq: [{ $type: '$booking.start_at' }, 'date'] }, { $eq: [{ $type: '$booking.end_at' }, 'date'] },
      { $gt: ['$booking.end_at', '$booking.start_at'] },
      { $in: [{ $type: '$comment' }, ['string', 'missing']] },
      { $in: [{ $type: '$trainer_name_snapshot' }, ['string', 'missing']] },
      { $in: [{ $type: '$member_display_name_snapshot' }, ['string', 'missing']] },
    ] } } },
    // Chuẩn hóa kiểu trả về (BSON numeric → JS number), không ghi lại nguồn.
    { $set: { rating: { $convert: { input: '$rating', to: 'double', onError: null, onNull: null } } } },
  ];
}

@Injectable()
export class AdminTrainerReviewsRepository {
  constructor(@InjectModel('TrainerReview') private readonly reviews: Model<TrainerReview>, @InjectConnection() private readonly connection: Connection) {}

  trainers(session: ClientSession, trainerId?: Types.ObjectId): Promise<ReviewTrainer[]> {
    return this.connection.collection('trainers').aggregate<ReviewTrainer>([
      { $match: trainerId ? { _id: trainerId } : {} },
      { $sort: { created_at: -1, _id: -1 } },
      { $lookup: { from: 'accounts', localField: 'account_id', foreignField: '_id', pipeline: [{ $project: { full_name: 1 } }], as: 'account' } },
      { $project: { _id: 1, status: 1, currentTrainerName: { $first: '$account.full_name' } } },
    ], { session }).toArray();
  }

  async page(filter: AdminReviewFilter, session: ClientSession, includeItems: boolean): Promise<ReviewFacet> {
    const match: Record<string, unknown> = { created_at: { $gte: filter.from, $lt: filter.to } };
    if (filter.trainerId) match.trainer_id = filter.trainerId;
    if (filter.rating !== undefined) match.rating = filter.rating;
    const [result] = await this.reviews.aggregate<ReviewFacet>([
      { $match: match }, ...sourceStages(),
      { $facet: {
        groups: [
          { $match: { valid: true } },
          { $group: { _id: '$trainer_id', reviewCount: { $sum: 1 }, ratingSum: { $sum: '$rating' },
            ...Object.fromEntries([1, 2, 3, 4, 5].map(star => [`star${star}`, { $sum: { $cond: [{ $eq: ['$rating', star] }, 1, 0] } }])) } },
        ],
        invalid: [{ $match: { valid: { $ne: true } } }, { $project: { _id: 1 } }],
        counts: [{ $match: { valid: true } }, { $count: 'total' }],
        items: includeItems ? [
          { $match: { valid: true } }, { $sort: { created_at: -1, _id: -1 } },
          { $skip: (filter.page - 1) * filter.limit }, { $limit: filter.limit }, projection,
        ] : [{ $match: { _id: { $exists: false } } }],
      } },
    ]).session(session).exec();
    return result;
  }

  async detail(id: Types.ObjectId, session: ClientSession): Promise<AdminReviewRow | null> {
    const [row] = await this.reviews.aggregate<AdminReviewRow>([
      { $match: { _id: id } }, ...sourceStages(), { $match: { valid: true } }, projection,
    ]).session(session).exec();
    return row ?? null;
  }
}
