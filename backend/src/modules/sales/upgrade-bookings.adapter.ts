import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession } from 'mongodb';
import { Model, Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { addCalendarDays } from '../../common/utils/business-date';
import { PtBooking } from '../bookings/schemas/pt-booking.schema';

export interface UpgradeQuota { used: number; reserved: number; targetSessions: number; requiredSessions: number }
@Injectable()
export class UpgradeBookingsAdapter {
  constructor(@InjectModel('PtBooking') private readonly bookings: Model<PtBooking>) {}

  async inspect(input: { memberId: Types.ObjectId; membershipId: Types.ObjectId; kind: 'GYM' | 'PT'; used: number;
    targetSessions: number; startDate: string; endDate: string; now: Date }, session?: ClientSession) {
    const booked = await this.bookings.find({ membership_id: input.membershipId, status: 'BOOKED' }).session(session ?? null).lean().exec();
    const used = input.kind === 'PT' ? input.used : 0;
    if (!Number.isSafeInteger(used) || used < 0) throw new ApplicationError(409, 'SOURCE_CHANGED', 'Dữ liệu sử dụng kỳ nguồn không hợp lệ');
    const quotaSummary: UpgradeQuota = { used, reserved: booked.length, targetSessions: input.targetSessions, requiredSessions: used + booked.length };
    const periodStart = new Date(`${input.startDate}T00:00:00+07:00`), periodEnd = new Date(`${addCalendarDays(input.endDate, 1)}T00:00:00+07:00`);
    const invalid = booked.some(row => input.kind !== 'PT' || !row.member_id.equals(input.memberId) ||
      row.start_at <= input.now || row.start_at < periodStart || row.end_at > periodEnd || row.end_at <= row.start_at);
    const blockingCode = invalid ? 'BOOKING_CONFLICT' : quotaSummary.requiredSessions > input.targetSessions ? 'QUOTA_INSUFFICIENT' : undefined;
    return { quotaSummary, booked, blockingCode };
  }

  // Member gate is already held by the caller. A CAS miss aborts the entire settlement.
  async moveWithinSession(ids: Types.ObjectId[], memberId: Types.ObjectId, sourceId: Types.ObjectId,
    targetId: Types.ObjectId, now: Date, session: ClientSession): Promise<void> {
    if (!ids.length) return;
    const changed = await this.bookings.updateMany({ _id: { $in: ids }, member_id: memberId, membership_id: sourceId, status: 'BOOKED', start_at: { $gt: now } },
      { $set: { membership_id: targetId, updated_at: now }, $inc: { version: 1 } }, { session, runValidators: true });
    if (changed.modifiedCount !== ids.length) throw new ApplicationError(409, 'BOOKING_CONFLICT', 'Lịch PT đã thay đổi. Hãy kiểm tra lại');
  }
}
