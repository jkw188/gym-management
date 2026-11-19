// Tầng nghiệp vụ dùng chung (US-17 bước 1): resolver chủ thể – đổi account đang đăng nhập thành memberId của chính họ.
// US-17-F01: chỉ dựa vào members.account_id = principal; không nhận memberId từ client, không tự nối hồ sơ theo phone.
// US-18/19/20 lấy chủ sở hữu bằng cùng resolver này.
import { Injectable } from '@nestjs/common';
import { ClientSession } from 'mongodb';
import { Types } from 'mongoose';
import { MembersRepository } from './members.repository';

@Injectable()
export class MemberOwnerReader {
  constructor(private readonly members: MembersRepository) {}

  // Trả null khi account chưa được liên kết hồ sơ (US-17-TC03); nơi gọi tự quyết định trả memberLinked=false hay 404.
  // session (không bắt buộc): US-42 đọc member trong cùng transaction snapshot với dữ liệu đơn.
  findMemberIdOfAccount(accountId: string, session?: ClientSession): Promise<Types.ObjectId | null> {
    return this.members.findIdByAccountId(new Types.ObjectId(accountId), session);
  }
}
