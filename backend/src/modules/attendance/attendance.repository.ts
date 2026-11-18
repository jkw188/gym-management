import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ClientSession, Document, Filter } from 'mongodb';
import { Connection, Types } from 'mongoose';
import { WorkShift } from '../shifts/schemas/work-shift.schema';
import { AttendanceRecord } from './attendance.schema';

@Injectable()
export class AttendanceRepository {
  constructor(@InjectConnection() private readonly connection: Connection) {}
  private get records() { return this.connection.db!.collection<AttendanceRecord>('trainer_attendance'); }
  shift(id: Types.ObjectId, session: ClientSession) {
    return this.connection.db!.collection<WorkShift>('work_shifts').findOne({ _id: id }, { session });
  }
  trainer(id: Types.ObjectId, session: ClientSession) {
    return this.connection.db!.collection('trainers').findOne({ _id: id }, { session, projection: { _id: 1, account_id: 1 } });
  }
  find(shiftId: Types.ObjectId, session: ClientSession) { return this.records.findOne({ shift_id: shiftId }, { session }); }
  async insert(record: AttendanceRecord, session: ClientSession) { await this.records.insertOne(record, { session }); return record; }
  update(current: AttendanceRecord, change: Partial<AttendanceRecord>, clearCheckout: boolean, session: ClientSession) {
    return this.records.findOneAndUpdate({ _id: current._id, version: current.version }, {
      $set: change, $inc: { version: 1 }, ...(clearCheckout ? { $unset: { check_out_at: '', checked_out_by: '' } } : {}),
    }, { session, returnDocument: 'after' });
  }
  async event(event: Document, session: ClientSession) { await this.connection.db!.collection('attendance_events').insertOne(event, { session }); }
  async list(filter: Filter<WorkShift>, page: number, limit: number, session: ClientSession) {
    const shifts = this.connection.db!.collection<WorkShift>('work_shifts');
    const items = await shifts.aggregate<Document>([
      { $match: filter }, { $sort: { start_at: 1, _id: 1 } }, { $skip: (page - 1) * limit }, { $limit: limit },
      { $lookup: { from: 'trainer_attendance', localField: '_id', foreignField: 'shift_id', as: 'attendance' } },
      { $lookup: { from: 'trainers', localField: 'trainer_id', foreignField: '_id', as: 'trainer' } },
      { $set: { trainerExists: { $gt: [{ $size: '$trainer' }, 0] } } },
    ], { session, maxTimeMS: 5000 }).toArray();
    const total = await shifts.countDocuments(filter, { session });
    // Narrow attendance picker; does not expose the administrative US-32 query to Staff.
    const trainers = await this.connection.db!.collection('trainers').aggregate<Document>([
      { $lookup: { from: 'accounts', localField: 'account_id', foreignField: '_id', as: 'account' } },
      { $project: { _id: 1, displayName: { $first: '$account.full_name' } } }, { $sort: { displayName: 1, _id: 1 } },
    ], { session, maxTimeMS: 5000 }).toArray();
    return { items, total, trainers };
  }
}
