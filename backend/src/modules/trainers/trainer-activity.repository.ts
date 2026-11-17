import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ClientSession, Document, ObjectId } from 'mongodb';
import { Connection } from 'mongoose';
import { ActivityRange, ActivitySummary } from './trainer-activity.types';

export interface ActivityStats extends Partial<ActivitySummary> { _id: ObjectId; dataIssueCount?: number }
const exists = (collection: string, field: string, output: string): Document[] => [
  { $lookup: { from: collection, localField: field, foreignField: '_id', pipeline: [{ $project: { _id: 1 } }], as: output } },
  { $set: { [output]: { $gt: [{ $size: `$${output}` }, 0] } } },
];
const shiftSources: Document[] = [
  { $lookup: { from: 'trainer_attendance', localField: '_id', foreignField: 'shift_id', as: 'attendance' } },
  ...exists('trainers', 'trainer_id', 'trainerExists'),
];
const bookingSources: Document[] = [
  ...exists('trainers', 'trainer_id', 'trainerExists'), ...exists('members', 'member_id', 'memberExists'),
  ...exists('work_shifts', 'shift_id', 'shiftExists'),
];

@Injectable()
export class TrainerActivityRepository {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  private aggregate<T extends Document>(collection: string, pipeline: Document[], session: ClientSession): Promise<T[]> {
    return this.connection.db!.collection(collection).aggregate<T>(pipeline, { session, maxTimeMS: 5000 }).toArray();
  }
  private condition(range: ActivityRange, trainerId?: ObjectId): Document {
    return { start_at: { $gte: range.from, $lt: range.to }, ...(trainerId ? { trainer_id: trainerId } : {}) };
  }
  trainers(session: ClientSession, trainerId?: ObjectId): Promise<Document[]> {
    return this.aggregate('trainers', [
      { $match: trainerId ? { _id: trainerId } : {} },
      { $lookup: { from: 'accounts', localField: 'account_id', foreignField: '_id', pipeline: [{ $project: { full_name: 1 } }], as: 'account' } },
      { $project: { _id: 1, status: 1, created_at: 1, displayName: { $first: '$account.full_name' } } },
    ], session);
  }

  // Aggregate sources separately; attendance lookup never unwinds, so duplicate/corrupt records cannot multiply shifts.
  shiftStats(range: ActivityRange, session: ClientSession, trainerId?: ObjectId): Promise<ActivityStats[]> {
    return this.aggregate<ActivityStats>('work_shifts', [
      { $match: this.condition(range, trainerId) }, ...shiftSources,
      { $set: { a: { $first: '$attendance' }, attendanceSize: { $size: '$attendance' } } },
      { $set: {
        closed: { $and: [{ $gt: ['$attendanceSize', 0] }, { $ne: [{ $ifNull: ['$a.check_out_at', null] }, null] }] },
        valid: { $and: [
          { $eq: ['$attendanceSize', 1] }, { $eq: ['$a.trainer_id', '$trainer_id'] },
          { $eq: [{ $type: '$a.check_in_at' }, 'date'] }, { $eq: [{ $type: '$a.check_out_at' }, 'date'] },
          { $gt: ['$a.check_out_at', '$a.check_in_at'] },
        ] },
      } },
      { $group: {
        _id: '$trainer_id', shiftCount: { $sum: 1 },
        attendanceMissing: { $sum: { $cond: [{ $eq: ['$attendanceSize', 0] }, 1, 0] } },
        attendanceClosed: { $sum: { $cond: ['$closed', 1, 0] } },
        attendanceOpen: { $sum: { $cond: [{ $and: [{ $gt: ['$attendanceSize', 0] }, { $not: ['$closed'] }] }, 1, 0] } },
        actualMinutesTotal: { $sum: { $cond: ['$valid', { $divide: [{ $subtract: ['$a.check_out_at', '$a.check_in_at'] }, 60000] }, 0] } },
        dataIssueCount: { $sum: { $cond: [{ $or: [{ $gt: ['$attendanceSize', 1] }, { $and: ['$closed', { $not: ['$valid'] }] }] }, 1, 0] } },
      } },
    ], session);
  }
  bookingStats(range: ActivityRange, session: ClientSession, trainerId?: ObjectId): Promise<ActivityStats[]> {
    return this.aggregate<ActivityStats>('pt_bookings', [
      { $match: this.condition(range, trainerId) },
      { $group: { _id: '$trainer_id', bookingCount: { $sum: 1 },
        completedCount: { $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, 1, 0] } },
        cancelledCount: { $sum: { $cond: [{ $eq: ['$status', 'CANCELLED'] }, 1, 0] } },
        pendingCompletionCount: { $sum: { $cond: [{ $eq: ['$status', 'BOOKED'] }, 1, 0] } },
      } },
    ], session);
  }
  orphanAttendance(session: ClientSession, trainerId?: ObjectId): Promise<Document[]> {
    return this.aggregate('trainer_attendance', [
      { $match: trainerId ? { trainer_id: trainerId } : {} },
      ...exists('work_shifts', 'shift_id', 'shiftExists'),
      { $match: { shiftExists: false } }, { $group: { _id: '$trainer_id' } },
    ], session);
  }
  async page(collection: 'work_shifts' | 'pt_bookings', range: ActivityRange, trainerId: ObjectId, page: number, limit: number, session: ClientSession) {
    const [result] = await this.aggregate<{ items: Document[]; count: { total: number }[] }>(collection, [
      { $match: this.condition(range, trainerId) },
      { $facet: {
        items: [{ $sort: { created_at: -1, _id: -1 } }, { $skip: (page - 1) * limit }, { $limit: limit },
          ...(collection === 'work_shifts' ? shiftSources : bookingSources)],
        count: [{ $count: 'total' }],
      } },
    ], session);
    return { items: result.items, total: result.count[0]?.total ?? 0 };
  }
  async shift(id: ObjectId, session: ClientSession): Promise<Document | null> {
    const rows = await this.aggregate('work_shifts', [{ $match: { _id: id } }, ...shiftSources], session);
    return rows[0] ?? null;
  }
  attendanceEvents(shiftId: ObjectId, session: ClientSession): Promise<Document[]> {
    return this.aggregate('attendance_events', [{ $match: { shift_id: shiftId } }, { $sort: { occurred_at: 1, _id: 1 } },
      { $project: { _id: 1, attendance_id: 1, action: 1, actor_id: 1, occurred_at: 1, reason: 1,
        'before.check_in_at': 1, 'before.check_out_at': 1, 'before.version': 1,
        'after.check_in_at': 1, 'after.check_out_at': 1, 'after.version': 1 } }], session);
  }
}
