import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Schema, Types } from 'mongoose';

// Chỉ mô tả các field cần đọc theo báo cáo mục 4.2.7; không cung cấp thao tác ghi hồ sơ.
export interface MemberRegistrationRecord { phone: string; account_id?: Types.ObjectId | null }
export const MemberRegistrationSchema = new Schema<MemberRegistrationRecord>({
  phone: String, account_id: Schema.Types.ObjectId,
}, { collection: 'members', versionKey: false, strict: 'throw' });
// Index phục vụ đọc; schema/constraint nghiệp vụ đầy đủ do US-09 quản lý.
MemberRegistrationSchema.index({ phone: 1 }, { name: 'members_phone_lookup' });

@Injectable()
export class MemberRegistrationReader implements OnModuleInit {
  constructor(@InjectModel('MemberRegistration') private readonly members: Model<MemberRegistrationRecord>,
    private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    if (this.config.get('nodeEnv') !== 'production') await this.members.createIndexes();
    const indexes = await this.members.collection.listIndexes().toArray();
    if (!indexes.some(index => Object.keys(index.key)[0] === 'phone' && index.key.phone === 1 && !index.partialFilterExpression && !index.sparse)) {
      throw new Error('DATABASE_INDEXES_REQUIRED: run npm run ensure-indexes');
    }
  }

  async hasUnlinkedPhone(phone: string): Promise<boolean> {
    // null khớp cả field thiếu và null; chỉ trả boolean, không xuất dữ liệu cá nhân.
    return !!await this.members.exists({ phone, account_id: null }).maxTimeMS(5000).exec();
  }
}
