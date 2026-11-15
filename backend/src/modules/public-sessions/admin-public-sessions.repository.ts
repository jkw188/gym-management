import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession } from 'mongodb';
import { Connection, Model, Types } from 'mongoose';
import { AdminSessionQueryDto } from './admin-public-sessions.dto';
import { SessionDraft } from './public-session.policy';
import { PublicSession } from './schemas/public-session.schema';
import { PublicSessionEvent } from './schemas/public-session-event.schema';

@Injectable()
export class AdminPublicSessionsRepository {
  constructor(@InjectModel('PublicSession') private readonly sessions: Model<PublicSession>,
    @InjectModel('PublicSessionEvent') private readonly events: Model<PublicSessionEvent>,
    @InjectConnection() private readonly connection: Connection) {}

  async list(query: AdminSessionQueryDto, range: { from: Date; to: Date }) {
    const filter = { start_at: { $lt: range.to }, end_at: { $gt: range.from },
      ...(query.status ? { status: query.status } : {}), ...(query.subjectCode ? { subject_code: query.subjectCode } : {}),
      ...(query.trainerId ? { trainer_id: new Types.ObjectId(query.trainerId) } : {}) };
    const [items, total] = await Promise.all([
      this.sessions.find(filter).sort({ start_at: 1, _id: 1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean().exec(),
      this.sessions.countDocuments(filter).exec(),
    ]);
    return { items, total };
  }
  find(id: Types.ObjectId, session?: ClientSession) {
    return this.sessions.findById(id).session(session ?? null).lean().exec();
  }
  async eligibleTrainer(id: Types.ObjectId, session?: ClientSession) {
    const trainer = await this.connection.db!.collection('trainers').findOne({ _id: id, status: 'ACTIVE' }, { session });
    if (!trainer) return false;
    const account = await this.connection.db!.collection('accounts').findOne({ _id: trainer.account_id, status: 'ACTIVE' }, { session });
    return Boolean(account && await this.connection.db!.collection('roles').findOne({ _id: account.role_id, code: 'TRAINER' }, { session }));
  }
  async conflicts(trainerId: Types.ObjectId, startAt: Date, endAt: Date, exclude?: Types.ObjectId, session?: ClientSession) {
    const filter = { trainer_id: trainerId, start_at: { $lt: endAt }, end_at: { $gt: startAt } };
    // Không trả id/identity của người đặt; không xét ca hoặc địa điểm như tài nguyên độc quyền.
    const classes = await this.sessions.exists({ ...filter, status: 'PUBLISHED', ...(exclude ? { _id: { $ne: exclude } } : {}) })
      .session(session ?? null).exec();
    const booking = await this.connection.db!.collection('pt_bookings').findOne({ ...filter, status: { $in: ['BOOKED', 'COMPLETED'] } },
      { session, projection: { _id: 1 } });
    return [...(classes ? ['SESSION_OVERLAP'] : []), ...(booking ? ['BOOKING_CONFLICT'] : [])];
  }
  async insert(draft: SessionDraft, actor: Types.ObjectId, now: Date, session: ClientSession) {
    const [row] = await this.sessions.create([{ ...draftFields(draft), status: 'DRAFT', version: 0,
      created_by: actor, updated_by: actor, created_at: now, updated_at: now }], { session });
    return row.toObject();
  }
  change(current: PublicSession, changes: Partial<PublicSession>, actor: Types.ObjectId, now: Date, session: ClientSession) {
    return this.sessions.findOneAndUpdate({ _id: current._id, version: current.version, status: current.status },
      { $set: { ...changes, updated_by: actor, updated_at: now }, $inc: { version: 1 } },
      { session, returnDocument: 'after', runValidators: true, timestamps: false }).lean().exec();
  }
  async insertEvent(event: PublicSessionEvent, session: ClientSession) {
    await this.events.create([event], { session });
  }
}
export function draftFields(draft: SessionDraft) {
  return { title: draft.title, trainer_id: new Types.ObjectId(draft.trainerId), subject_code: draft.subjectCode,
    location: draft.location, start_at: draft.startAt, end_at: draft.endAt };
}
