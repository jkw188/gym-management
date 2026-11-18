import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ClientSession, Document, ObjectId } from 'mongodb';
import { Connection } from 'mongoose';
import { reportRange } from './report-interval';

// Deliberately unknown legacy values: invalid source data must remain visible.
export interface PerformanceSource extends Record<string, unknown> { _id: ObjectId }
export interface PerformanceSources {
  trainers: PerformanceSource[]; accounts: PerformanceSource[]; shifts: PerformanceSource[];
  attendance: PerformanceSource[]; bookings: PerformanceSource[]; reviews: PerformanceSource[];
  linkedShifts: PerformanceSource[]; linkedBookings: PerformanceSource[]; members: PerformanceSource[];
}
const timeProjection = { _id: 1, trainer_id: 1, start_at: 1, end_at: 1, status: 1, created_at: 1, updated_at: 1, created_by: 1 };
@Injectable()
export class TrainerPerformanceRepository {
  constructor(@InjectConnection() private readonly connection: Connection) {}
  async snapshot<T>(read: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = await this.connection.startSession({ snapshot: true });
    try { return await read(session); } finally { await session.endSession(); }
  }
  async sources(session: ClientSession, range: ReturnType<typeof reportRange>, trainerId?: string): Promise<PerformanceSources> {
    const read = (name: string, projection: Document, filter: Document = {}) => this.connection.db!.collection<PerformanceSource>(name)
      .find(filter, { projection, session, readPreference: 'primary', timeoutMS: 5000 }).toArray();
    const trainer = trainerId ? { trainer_id: new ObjectId(trainerId) } : {};
    const start = new Date(range.start), end = new Date(range.effectiveTo);
    // Include corrupt/undated records as issues instead of silently losing them in a date match.
    const overlap = { $or: [{ start_at: { $lt: end }, end_at: { $gt: start } },
      { start_at: { $not: { $type: 'date' } } }, { end_at: { $not: { $type: 'date' } } }, { $expr: { $lte: ['$end_at', '$start_at'] } }] };
    const trainers = await read('trainers', { _id: 1, account_id: 1, status: 1 }, trainerId ? { _id: new ObjectId(trainerId) } : {});
    const accounts = await read('accounts', { _id: 1, full_name: 1 }, { _id: { $in: trainers.map(t => t.account_id) } });
    const shifts = await read('work_shifts', timeProjection, { ...trainer, status: { $in: ['CONFIRMED', 'COMPLETED'] }, ...overlap });
    const bookings = await read('pt_bookings', { ...timeProjection, shift_id: 1, member_id: 1, completed_at: 1, completed_by: 1 },
      { ...trainer, status: 'COMPLETED', ...overlap });
    // A CLOSED attendance can intersect W even when its planned shift does not (overtime).
    const attendance = await read('trainer_attendance', { _id: 1, shift_id: 1, trainer_id: 1, check_in_at: 1, check_out_at: 1,
      recorded_by: 1, checked_out_by: 1, created_at: 1, updated_at: 1 }, { $or: [
      { shift_id: { $in: shifts.map(s => s._id) } },
      { ...trainer, $or: [{ check_in_at: { $lt: end }, check_out_at: { $gt: start } },
        { check_in_at: { $lt: end }, check_out_at: null }, { check_in_at: { $not: { $type: 'date' } } },
        { check_out_at: { $exists: true, $ne: null, $not: { $type: 'date' } } },
        { $expr: { $and: [{ $ne: ['$check_out_at', null] }, { $lte: ['$check_out_at', '$check_in_at'] }] } }] },
    ] });
    const reviews = await read('trainer_reviews', { _id: 1, trainer_id: 1, booking_id: 1, member_id: 1, rating: 1, created_at: 1, created_by: 1 },
      { ...trainer, $or: [{ created_at: { $gte: start, $lt: end } }, { created_at: { $not: { $type: 'date' } } }] });
    const linkedShifts = await read('work_shifts', timeProjection, { _id: { $in: [...bookings, ...attendance].map(b => b.shift_id).filter(v => v instanceof ObjectId) } });
    const linkedBookings = await read('pt_bookings', { ...timeProjection, member_id: 1 },
      { _id: { $in: reviews.map(r => r.booking_id).filter(v => v instanceof ObjectId) } });
    const members = await read('members', { _id: 1 }, { _id: { $in: [...bookings, ...reviews].map(b => b.member_id).filter(v => v instanceof ObjectId) } });
    return { trainers, accounts, shifts, attendance, bookings, reviews, linkedShifts, linkedBookings, members };
  }
}
