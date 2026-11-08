// Tầng kiểu dữ liệu (US-09 bước 1): đổi document members thành MemberDto trả về client.
// Không trả created_by, updated_by, service_revision (field nội bộ).
import { MemberResponse } from './members.types';
import { Member } from './schemas/member.schema';

export function toMemberResponse(member: Member): MemberResponse {
  const response: MemberResponse = {
    id: member._id.toHexString(),
    memberCode: member.member_code,
    fullName: member.full_name,
    phone: member.phone,
    version: member.version,
    createdAt: member.created_at.toISOString(),
    updatedAt: member.updated_at.toISOString(),
  };
  // Field tùy chọn chỉ thêm khi có giá trị (US-09-TC01: chưa liên kết thì không có accountId).
  if (member.birth_date) response.birthDate = member.birth_date;
  if (member.address) response.address = member.address;
  if (member.account_id) response.accountId = member.account_id.toHexString();
  return response;
}
