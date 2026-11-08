// Tầng dữ liệu (US-01, cập nhật US-09 bước 1): hàm chỉ-đọc mà MembersModule cho module khác dùng khi khách
// tự đăng ký tài khoản. Đọc qua MembersRepository; không mở quyền ghi collection members ra ngoài module.
import { Injectable } from '@nestjs/common';
import { MembersRepository } from './members.repository';

@Injectable()
export class MemberRegistrationReader {
  constructor(private readonly members: MembersRepository) {}

  hasUnlinkedPhone(phone: string): Promise<boolean> {
    return this.members.hasUnlinkedPhone(phone);
  }
}
