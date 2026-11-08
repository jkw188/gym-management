// Tầng dữ liệu (US-01, cập nhật US-09 bước 1): đọc collection members khi khách tự đăng ký tài khoản.
// Dùng chung MemberSchema của MembersModule (US-09 sở hữu schema/index); ở đây chỉ đọc, không ghi hồ sơ.
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Member } from './schemas/member.schema';

// Index phone không unique do US-01 tạo trước khi có US-09. Cùng key {phone:1} với index unique mới nên
// MongoDB không cho tồn tại song song; DB cũ cần xóa index này trước khi tạo index mới.
export const LEGACY_PHONE_INDEX = 'members_phone_lookup';

@Injectable()
export class MemberRegistrationReader implements OnModuleInit {
  constructor(@InjectModel('MemberRegistration') private readonly members: Model<Member>,
    private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    if (this.config.get('nodeEnv') !== 'production') {
      const indexes = await this.members.collection.listIndexes().toArray().catch(() => []);
      if (indexes.some(index => index.name === LEGACY_PHONE_INDEX)) await this.members.collection.dropIndex(LEGACY_PHONE_INDEX);
      await this.members.createIndexes();
    }
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
