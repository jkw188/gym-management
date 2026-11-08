// Tầng dữ liệu (US-09 bước 1–3): nơi duy nhất đọc/ghi collection members, member_link_events và quản lý index của chúng.
// Lệnh trong transaction nhận session rõ ràng.
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Collection, MongoServerError } from 'mongodb';
import { Model, Types } from 'mongoose';
import { NewMemberInput } from './members.types';
import { MemberLinkEvent, VerificationMethod } from './schemas/member-link-event.schema';
import { Member } from './schemas/member.schema';

// US-09 bước 3: dữ liệu ghi vào member_link_events (tên field camelCase, repository đổi sang snake_case).
export interface NewLinkEvent {
  memberId: Types.ObjectId;
  accountId: Types.ObjectId;
  verifiedBy: Types.ObjectId;
  verifiedAt: Date;
  verificationMethod: VerificationMethod;
  verificationNote: string;
  requestKey: string;
}

@Injectable()
export class MembersRepository implements OnModuleInit {
  constructor(
    @InjectModel('Member') private readonly members: Model<Member>,
    @InjectModel('MemberLinkEvent') private readonly linkEvents: Model<MemberLinkEvent>,
    private readonly config: ConfigService,
  ) {}

  // Dev/test tự tạo index; production chỉ kiểm tra index đã có (chạy npm run ensure-indexes trước).
  async onModuleInit(): Promise<void> {
    if (this.config.get('nodeEnv') !== 'production') {
      await dropLegacyPhoneIndex(this.members.collection);
      await this.members.createIndexes();
      await this.linkEvents.createIndexes();
    }
    for (const model of [this.members, this.linkEvents] as Model<unknown>[]) {
      const actual = await model.collection.listIndexes().toArray();
      for (const [key, options] of model.schema.indexes()) {
        const found = actual.some(index => JSON.stringify(index.key) === JSON.stringify(key) && Boolean(index.unique) === Boolean(options.unique));
        if (!found) throw new Error('DATABASE_INDEXES_REQUIRED: run npm run ensure-indexes');
      }
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

  // US-09-F05: account đã được một hồ sơ hội viên tham chiếu thì không liên kết thêm được.
  // Truyền session khi kiểm trong transaction liên kết (bước 3).
  async isAccountLinked(accountId: Types.ObjectId, session?: ClientSession): Promise<boolean> {
    return !!await this.members.exists({ account_id: accountId }).session(session ?? null).maxTimeMS(5000).exec();
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

  // US-09-F06: ghi tăng service_revision của hồ sơ (khóa bán gói/liên kết theo hồ sơ) và trả hồ sơ sau khi ghi.
  // null nghĩa là không có hồ sơ này.
  bumpServiceRevision(memberId: Types.ObjectId, session: ClientSession): Promise<Member | null> {
    return this.members.findOneAndUpdate({ _id: memberId }, { $inc: { service_revision: 1n } },
      { session, returnDocument: 'after' }).lean<Member>().exec();
  }

  // US-09-TC08: gắn account vào hồ sơ đúng version (CAS), version + 1, người sửa là nhân viên.
  // null nghĩa là version đã đổi hoặc hồ sơ đã có account_id.
  setAccount(memberId: Types.ObjectId, version: number, accountId: Types.ObjectId, actorId: Types.ObjectId,
    session: ClientSession): Promise<Member | null> {
    return this.members.findOneAndUpdate(
      { _id: memberId, version, account_id: { $exists: false } },
      { $set: { account_id: accountId, updated_by: actorId }, $inc: { version: 1 } },
      { session, returnDocument: 'after', runValidators: true },
    ).lean<Member>().exec();
  }

  async insertLinkEvent(event: NewLinkEvent, session: ClientSession): Promise<void> {
    await this.linkEvents.create([{
      member_id: event.memberId,
      account_id: event.accountId,
      verified_by: event.verifiedBy,
      verified_at: event.verifiedAt,
      verification_method: event.verificationMethod,
      verification_note: event.verificationNote,
      request_key: event.requestKey,
    }], { session });
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

// Mã 11000 là vi phạm unique index; keyPattern cho biết index nào.
function isDuplicateOn(error: unknown, keyPattern: Record<string, number>): boolean {
  return error instanceof MongoServerError && error.code === 11000 && JSON.stringify(error.keyPattern) === JSON.stringify(keyPattern);
}

// Trùng index phone của members (US-09-TC05).
export function isDuplicatePhone(error: unknown): boolean {
  return isDuplicateOn(error, { phone: 1 });
}

// Trùng partial unique index account_id của members: account đã gắn hồ sơ khác (bước 4 kiểm tranh chấp).
export function isDuplicateAccount(error: unknown): boolean {
  return isDuplicateOn(error, { account_id: 1 });
}
