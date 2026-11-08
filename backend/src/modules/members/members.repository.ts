// Tầng dữ liệu (US-09 bước 1): nơi duy nhất đọc/ghi collection members và quản lý index của nó.
// Lệnh trong transaction nhận session rõ ràng.
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Collection, MongoServerError } from 'mongodb';
import { Model, Types } from 'mongoose';
import { NewMemberInput } from './members.types';
import { Member } from './schemas/member.schema';

@Injectable()
export class MembersRepository implements OnModuleInit {
  constructor(@InjectModel('Member') private readonly members: Model<Member>, private readonly config: ConfigService) {}

  // Dev/test tự tạo index; production chỉ kiểm tra index đã có (chạy npm run ensure-indexes trước).
  async onModuleInit(): Promise<void> {
    if (this.config.get('nodeEnv') !== 'production') {
      await dropLegacyPhoneIndex(this.members.collection);
      await this.members.createIndexes();
    }
    const actual = await this.members.collection.listIndexes().toArray();
    for (const [key, options] of this.members.schema.indexes()) {
      const found = actual.some(index => JSON.stringify(index.key) === JSON.stringify(key) && Boolean(index.unique) === Boolean(options.unique));
      if (!found) throw new Error('DATABASE_INDEXES_REQUIRED: run npm run ensure-indexes');
    }
  }

  async existsByPhone(phone: string, session: ClientSession): Promise<boolean> {
    return !!await this.members.exists({ phone }).session(session).exec();
  }

  // US-01: có hồ sơ ngoại tuyến chưa liên kết trùng phone không. null khớp cả field thiếu và null;
  // chỉ trả boolean, không xuất dữ liệu cá nhân.
  async hasUnlinkedPhone(phone: string): Promise<boolean> {
    return !!await this.members.exists({ phone, account_id: null }).maxTimeMS(5000).exec();
  }

  // Tạo hồ sơ: _id sinh trước để member_code = "HV-" + id (US-09-F02). Không ghi account_id (US-09-TC04).
  async insertMember(input: NewMemberInput, actorId: Types.ObjectId, session: ClientSession): Promise<Member> {
    const _id = new Types.ObjectId();
    const [created] = await this.members.create([{
      _id,
      member_code: `HV-${_id.toHexString()}`,
      full_name: input.fullName,
      phone: input.phone,
      birth_date: input.birthDate,
      address: input.address,
      created_by: actorId,
      updated_by: actorId,
    }], { session });
    return created.toObject();
  }
}

// Index phone không unique do US-01 tạo trước khi có US-09. Cùng key {phone:1} với index unique mới nên MongoDB
// không cho tồn tại song song: xóa trước khi tạo index mới. Dùng ở onModuleInit và lệnh ensure-indexes (scripts/admin.cjs).
const LEGACY_PHONE_INDEX = 'members_phone_lookup';
export async function dropLegacyPhoneIndex(collection: Collection): Promise<void> {
  // Collection chưa tồn tại thì listIndexes lỗi: coi như chưa có index cũ.
  const indexes = await collection.listIndexes().toArray().catch(() => []);
  if (indexes.some(index => index.name === LEGACY_PHONE_INDEX)) await collection.dropIndex(LEGACY_PHONE_INDEX);
}

// Mã 11000 là vi phạm unique index; keyPattern cho biết index nào. Ở đây chỉ nhận index phone của members.
export function isDuplicatePhone(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11000 && JSON.stringify(error.keyPattern) === JSON.stringify({ phone: 1 });
}
