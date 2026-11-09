import { MemberDto } from './members.dto';
import { Member } from './schemas/member.schema';

export function toMemberResponse(member: Member): MemberDto {
  return { id: member._id.toHexString(), memberCode: member.member_code, fullName: member.full_name,
    phone: member.phone, version: Number(member.version),
    ...(member.birth_date ? { birthDate: member.birth_date } : {}),
    ...(member.address ? { address: member.address } : {}),
    ...(member.account_id ? { accountId: member.account_id.toHexString() } : {}),
    createdAt: member.created_at.toISOString(), updatedAt: member.updated_at.toISOString() };
}
