import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { MembersRepository } from './members.repository';
import { MemberSchema } from './schemas/member.schema';

// Chỉ mô tả các field cần đọc theo báo cáo mục 4.2.7; không cung cấp thao tác ghi hồ sơ.
export interface MemberRegistrationRecord { phone: string; account_id?: Types.ObjectId | null }
// US-01 keeps its read-only projection; US-09 owns the shared collection schema and constraints.
export const MemberRegistrationSchema = MemberSchema;

@Injectable()
export class MemberRegistrationReader {
  constructor(private readonly members: MembersRepository) {}

  hasUnlinkedPhone(phone: string): Promise<boolean> {
    return this.members.hasUnlinkedPhone(phone);
  }
}
