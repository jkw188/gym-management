import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import { ServiceSale } from '../memberships/schemas/service-sale.schema';
import { Membership } from '../memberships/schemas/membership.schema';
import { PtBooking } from '../bookings/schemas/pt-booking.schema';
import { Transaction } from '../payments/schemas/transaction.schema';
import { ReminderOccurrence } from './reminder-occurrence.schema';
import { ensureRemindersIntegrity, REMINDER_SOURCE_INDEXES } from './reminders-migration';
import { ReminderMilestone, ReminderSource, vietnamDay } from './reminder.policy';

export interface ReminderCandidate { sourceType: ReminderSource; sourceId: Types.ObjectId; milestone: ReminderMilestone; dueAt: Date }

@Injectable()
export class RemindersRepository implements OnModuleInit {
  constructor(@InjectConnection() private readonly connection: Connection,
    @InjectModel('ReminderOccurrence') private readonly occurrences: Model<ReminderOccurrence>, private readonly config: ConfigService) {}
  private get db() { return this.connection.db!; }

  async onModuleInit(): Promise<void> {
    if (this.config.get('nodeEnv') !== 'production') await ensureRemindersIntegrity(this.connection);
    const required = [
      { collection: 'reminder_occurrences', indexes: this.occurrences.schema.indexes().map(([key, options]) => ({ key, unique: options.unique })) },
      ...REMINDER_SOURCE_INDEXES.map(({ collection, index }) => ({ collection, indexes: [index] })),
    ];
    for (const { collection, indexes } of required) {
      const actual = await this.db.collection(collection).listIndexes().toArray();
      if (actual.some(index => index.expireAfterSeconds !== undefined) || indexes.some(expected => !actual.some(index =>
        JSON.stringify(index.key) === JSON.stringify(expected.key) && Boolean(index.unique) === Boolean(expected.unique) &&
        !index.sparse && index.partialFilterExpression === undefined && (!index.collation || index.collation.locale === 'simple')))) {
        throw new Error('DATABASE_INDEXES_REQUIRED: run npm run ensure-indexes');
      }
    }
  }

  async candidates(now: Date, limit: number): Promise<ReminderCandidate[]> {
    // Anti-join loại terminal TRƯỚC limit; nguồn lỗi không làm dừng xử lý các candidate còn lại trong batch.
    // Cả hai milestone lấy trực tiếp từ nguồn thật, kể cả nguồn đã cancel để ghi quyết định skip đến hạn.
    const missing = [
      { $match: { dueAt: { $lte: now } } },
      { $lookup: { from: 'reminder_occurrences', let: { sourceId: '$sourceId', sourceType: '$sourceType', milestone: '$milestone' },
        pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$source_id', '$$sourceId'] },
          { $eq: ['$source_type', '$$sourceType'] }, { $eq: ['$milestone', '$$milestone'] }] } } }], as: 'occurrence' } },
      { $match: { occurrence: { $size: 0 } } },
      { $project: { _id: 0, sourceType: 1, sourceId: 1, milestone: 1, dueAt: 1 } },
    ];
    return this.db.collection('service_sales').aggregate<ReminderCandidate>([
      { $match: { end_date: { $lte: vietnamDay(new Date(now.getTime() + 3 * 86400000)) } } },
      { $lookup: { from: 'memberships', localField: '_id', foreignField: 'service_sale_id', as: 'membership' } },
      { $unwind: '$membership' },
      { $set: { milestone: ['3D', '1D'], endMidnight: { $dateFromString: { dateString: '$end_date', timezone: 'Asia/Ho_Chi_Minh' } } } },
      { $unwind: '$milestone' },
      { $project: { sourceType: { $literal: 'MEMBERSHIP' }, sourceId: '$membership._id', milestone: 1,
        dueAt: { $subtract: ['$endMidnight', { $cond: [{ $eq: ['$milestone', '3D'] }, 3 * 86400000, 86400000] }] } } },
      ...missing,
      { $unionWith: { coll: 'pt_bookings', pipeline: [
        { $match: { status: { $in: ['BOOKED', 'CANCELLED', 'COMPLETED'] }, start_at: { $lte: new Date(now.getTime() + 24 * 3600000) } } },
        { $set: { milestone: ['24H', '2H'] } }, { $unwind: '$milestone' },
        { $project: { sourceType: { $literal: 'PT_BOOKING' }, sourceId: '$_id', milestone: 1,
          dueAt: { $subtract: ['$start_at', { $cond: [{ $eq: ['$milestone', '24H'] }, 24 * 3600000, 2 * 3600000] }] } } },
        ...missing,
      ] } },
      { $sort: { dueAt: 1, sourceId: 1, milestone: 1 } }, { $limit: limit },
    ]).toArray();
  }

  findOccurrence(candidate: ReminderCandidate, session: ClientSession) {
    return this.occurrences.findOne({ source_type: candidate.sourceType, source_id: candidate.sourceId, milestone: candidate.milestone }).session(session).lean().exec();
  }
  async insert(data: Omit<ReminderOccurrence, '_id'>, session: ClientSession): Promise<void> { await this.occurrences.create([data], { session }); }
  membership(id: Types.ObjectId, session: ClientSession) { return this.db.collection<Membership>('memberships').findOne({ _id: id }, { session }); }
  sale(id: Types.ObjectId, session: ClientSession) { return this.db.collection<ServiceSale>('service_sales').findOne({ _id: id }, { session }); }
  transaction(id: Types.ObjectId, session: ClientSession) { return this.db.collection<Transaction>('transactions').findOne({ _id: id }, { session }); }
  booking(id: Types.ObjectId, session: ClientSession) { return this.db.collection<PtBooking>('pt_bookings').findOne({ _id: id }, { session }); }
  member(id: Types.ObjectId, session: ClientSession) { return this.db.collection<{ _id: Types.ObjectId; account_id?: Types.ObjectId }>('members').findOne({ _id: id }, { session }); }
  trainer(id: Types.ObjectId, session: ClientSession) { return this.db.collection<{ _id: Types.ObjectId; account_id?: Types.ObjectId }>('trainers').findOne({ _id: id }, { session }); }

  async linkedMemberAccount(memberId: Types.ObjectId, session: ClientSession): Promise<Types.ObjectId | undefined> {
    const member = await this.member(memberId, session);
    if (!member?.account_id) return;
    const account = await this.db.collection('accounts').findOne({ _id: member.account_id }, { session });
    if (!account) return;
    const role = await this.db.collection('roles').findOne({ _id: account.role_id, code: 'MEMBER' }, { session });
    return role ? member.account_id : undefined;
  }

  async hasContinuation(sale: ServiceSale, kind: string, nextDay: string, session: ClientSession): Promise<boolean> {
    const rows = await this.db.collection('service_sales').aggregate([
      { $match: { _id: { $ne: sale._id }, member_id: sale.member_id, start_date: { $lte: nextDay }, end_date: { $gte: nextDay } } },
      { $lookup: { from: 'memberships', localField: '_id', foreignField: 'service_sale_id', as: 'membership' } },
      { $match: { 'membership.status': 'ACTIVE' } },
      { $lookup: { from: 'transactions', localField: 'transaction_id', foreignField: '_id', as: 'transaction' } },
      { $match: { transaction: { $elemMatch: { kind, status: 'SETTLED' } } } }, { $limit: 1 },
    ], { session }).toArray();
    return rows.length > 0;
  }
}
