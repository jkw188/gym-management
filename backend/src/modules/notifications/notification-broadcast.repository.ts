import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import { RoleCode } from '../users/schemas/role.schema';
import { NotificationBroadcast } from './schemas/notification-broadcast.schema';

export interface AudienceAccount { _id: Types.ObjectId; roleId: Types.ObjectId; role: RoleCode }
@Injectable()
export class NotificationBroadcastRepository {
  constructor(@InjectModel('NotificationBroadcast') private readonly broadcasts: Model<NotificationBroadcast>,
    @InjectConnection() private readonly connection: Connection) {}

  audience(roles: readonly RoleCode[], session: ClientSession): Promise<AudienceAccount[]> {
    return this.connection.collection('accounts').aggregate<AudienceAccount>([
      { $match: { status: 'ACTIVE' } },
      { $lookup: { from: 'roles', localField: 'role_id', foreignField: '_id', as: 'role' } },
      { $unwind: '$role' }, { $match: { 'role.code': { $in: roles } } },
      { $sort: { _id: 1 } }, { $project: { _id: 1, roleId: '$role_id', role: '$role.code' } },
    ], { session }).toArray();
  }
  async insert(input: Omit<NotificationBroadcast, '_id'>, session: ClientSession) {
    const [row] = await this.broadcasts.create([input], { session });
    return row.toObject();
  }
  find(id: Types.ObjectId, session: ClientSession) { return this.broadcasts.findById(id).session(session).lean().exec(); }
  async markSent(row: NotificationBroadcast, notificationId: Types.ObjectId, now: Date, session: ClientSession) {
    const result = await this.broadcasts.updateOne({ _id: row._id, status: 'PREVIEW', version: row.version }, {
      $set: { status: 'SENT', notification_id: notificationId, sent_at: now }, $inc: { version: 1 },
    }, { session });
    if (result.modifiedCount !== 1) throw new Error('BROADCAST_WRITE_CONFLICT');
  }
  page(filter: { status?: string; from: Date; to: Date }, page: number, limit: number, session: ClientSession) {
    const match = { created_at: { $gte: filter.from, $lt: filter.to }, ...(filter.status ? { status: filter.status } : {}) };
    return this.broadcasts.aggregate<{ items: NotificationBroadcast[]; counts: { total: number }[] }>([
      { $match: match }, { $sort: { created_at: -1, _id: -1 } },
      { $facet: { items: [{ $skip: (page - 1) * limit }, { $limit: limit }], counts: [{ $count: 'total' }] } },
    ]).session(session).exec();
  }
  async progress(notificationId: Types.ObjectId, session: ClientSession) {
    const [counts] = await this.connection.collection('notification_recipients').aggregate<{ sent: number; delivered: number; read: number }>([
      { $match: { notification_id: notificationId } }, { $group: { _id: null, sent: { $sum: 1 },
        delivered: { $sum: { $cond: [{ $eq: [{ $type: '$delivered_at' }, 'date'] }, 1, 0] } },
        read: { $sum: { $cond: [{ $eq: [{ $type: '$read_at' }, 'date'] }, 1, 0] } },
      } },
    ], { session }).toArray();
    const job = await this.connection.collection('notification_outbox').findOne({ notification_id: notificationId }, { session, projection: { status: 1 } });
    return { counts: counts ? { sent: counts.sent, delivered: counts.delivered, read: counts.read } : { sent: 0, delivered: 0, read: 0 },
      dispatchStatus: job?.status as string | undefined ?? null };
  }
}
