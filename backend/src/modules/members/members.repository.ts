// Tầng dữ liệu (US-09 bước 1): nơi duy nhất ghi collection members. Lệnh trong transaction nhận session rõ ràng.
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, MongoServerError } from 'mongodb';
import { Model, Types } from 'mongoose';
import { NewMemberInput } from './members.types';
import { Member } from './schemas/member.schema';

@Injectable()
export class MembersRepository {
  constructor(@InjectModel('Member') private readonly members: Model<Member>) {}

  async existsByPhone(phone: string, session: ClientSession): Promise<boolean> {
    return !!await this.members.exists({ phone }).session(session).exec();
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

// Mã 11000 là vi phạm unique index; keyPattern cho biết index nào. Ở đây chỉ nhận index phone của members.
export function isDuplicatePhone(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11000 && JSON.stringify(error.keyPattern) === JSON.stringify({ phone: 1 });
}
