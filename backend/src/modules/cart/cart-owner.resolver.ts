// Tầng nghiệp vụ (US-40 bước 1): xác định giỏ của ai – đổi account đang đăng nhập thành memberId của chính họ.
// US-40-F01: chỉ dựa vào members.account_id = principal; không nhận memberId từ client, không tự link theo phone, không ghi DB.
import { Injectable } from '@nestjs/common';
import { MemberOwnerReader } from '../members/member-owner.reader';

// Kết quả: đã liên kết thì có memberId; chưa liên kết thì báo lý do để GET trả giỏ rỗng, lệnh ghi trả 409.
export type CartOwner =
  | { memberLinked: true; memberId: string }
  | { memberLinked: false; reason: 'MEMBER_PROFILE_REQUIRED' };

@Injectable()
export class CartOwnerResolver {
  constructor(private readonly memberOwner: MemberOwnerReader) {}

  async resolve(accountId: string): Promise<CartOwner> {
    // Dùng chung resolver của US-17 để mọi chức năng "của tôi" xác định chủ thể giống nhau.
    const memberId = await this.memberOwner.findMemberIdOfAccount(accountId);
    // US-40-TC03: chưa liên kết → memberLinked false, không tạo hồ sơ hay giỏ.
    if (!memberId) return { memberLinked: false, reason: 'MEMBER_PROFILE_REQUIRED' };
    // US-40-TC01, TC02: mỗi account chỉ ra Member của chính mình.
    return { memberLinked: true, memberId: memberId.toHexString() };
  }
}
