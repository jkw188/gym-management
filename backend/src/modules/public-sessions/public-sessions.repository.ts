// Tầng dữ liệu (US-26 bước 1): nơi duy nhất đọc public_sessions và tên PT (trainers → accounts) cho lịch công khai.
// Chỉ đọc, không ghi gì (US-26-TC10). Chỉ lấy lớp PUBLISHED; account chỉ lấy full_name.
import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { PublicSession } from './schemas/public-session.schema';
import { SubjectCode } from './public-sessions.types';

// Bộ lọc đã kiểm tra ở service: khoảng UTC [from, to) và các filter tùy chọn.
export interface PublishedSessionFilter {
  from: Date;
  to: Date;
  subjectCode?: SubjectCode;
  trainerId?: Types.ObjectId;
}

@Injectable()
export class PublicSessionsRepository {
  constructor(
    @InjectModel('PublicSession') private readonly sessions: Model<PublicSession>,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  // US-26-F02, TC05, TC06: lớp PUBLISHED GIAO khoảng lọc (start < to và end > from), kết hợp AND với bộ môn/PT.
  // Sắp start_at rồi _id để phân trang không rơi hay trùng lớp cùng giờ.
  async listPublished(filter: PublishedSessionFilter, page: number, limit: number) {
    const query: Record<string, unknown> = {
      status: 'PUBLISHED',
      start_at: { $lt: filter.to },
      end_at: { $gt: filter.from },
    };
    if (filter.subjectCode) query.subject_code = filter.subjectCode;
    if (filter.trainerId) query.trainer_id = filter.trainerId;
    const [items, total] = await Promise.all([
      this.sessions.find(query).sort({ start_at: 1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean().exec(),
      this.sessions.countDocuments(query).exec(),
    ]);
    return { items, total };
  }

  // US-26-TC02, TC09: chỉ tìm lớp PUBLISHED; DRAFT/CANCELLED coi như không tồn tại.
  findPublished(id: Types.ObjectId): Promise<PublicSession | null> {
    return this.sessions.findOne({ _id: id, status: 'PUBLISHED' }).lean().exec();
  }

  // US-26-F03: tên PT = accounts.full_name qua trainers.account_id. Chỉ lấy đúng field cần, không đọc phone/email.
  // US-26-TC11: không lọc theo status nên PT đã INACTIVE/LOCKED vẫn hiện tên ở lớp lịch sử.
  async findTrainerNames(trainerIds: Types.ObjectId[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    if (trainerIds.length === 0) return names;
    const trainers = await this.connection.db!.collection<{ _id: Types.ObjectId; account_id: Types.ObjectId }>('trainers')
      .find({ _id: { $in: trainerIds } }, { projection: { account_id: 1 } }).toArray();
    const accounts = await this.connection.db!.collection<{ _id: Types.ObjectId; full_name: string }>('accounts')
      .find({ _id: { $in: trainers.map(trainer => trainer.account_id) } }, { projection: { full_name: 1 } }).toArray();
    const nameByAccount = new Map(accounts.map(account => [account._id.toHexString(), account.full_name]));
    for (const trainer of trainers) {
      const name = nameByAccount.get(trainer.account_id.toHexString());
      if (name) names.set(trainer._id.toHexString(), name);
    }
    return names;
  }
}
