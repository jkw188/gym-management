// Tầng nghiệp vụ (US-09 bước 1): luật tạo hồ sơ hội viên tại quầy: chuẩn hóa dữ liệu, chống trùng phone,
// chống tạo lặp theo Idempotency-Key (EN-02). Tạo hồ sơ KHÔNG tạo account, gói, giao dịch hay buổi PT (US-09-F01).
import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { normalizeAddress, normalizeBirthDate, normalizeFullName, normalizePhone } from '../../common/utils/normalization';
import { IdempotencyService, WorkResult } from '../operations/idempotency.service';
import { CreateMemberDto } from './members.dto';
import { toMemberResponse } from './members.mapper';
import { isDuplicatePhone, MembersRepository } from './members.repository';
import { NewMemberInput } from './members.types';

@Injectable()
export class MembersService {
  constructor(private readonly repository: MembersRepository, private readonly idempotency: IdempotencyService) {}

  // POST /api/members. actorId lấy từ phiên đăng nhập, không nhận từ client.
  async create(actorId: string, dto: CreateMemberDto, clientKey: string) {
    // US-09-TC03: dữ liệu sai thì 400 ngay, chưa mở transaction nên không ghi gì.
    const input = normalizeInput(dto);

    return this.idempotency.execute(
      // US-09-TC06, US-09-TC07: hash theo dữ liệu ĐÃ chuẩn hóa; cùng key khác dữ liệu → 409 IDEMPOTENCY_CONFLICT.
      { actorId, operation: 'MEMBER_CREATE', clientKey, payload: { ...input } },
      async (session): Promise<WorkResult> => {
        // US-09-TC05: phone đã có hồ sơ → 409, kể cả hai request khác key.
        if (await this.repository.existsByPhone(input.phone, session)) throw phoneExists();
        try {
          const member = await this.repository.insertMember(input, new Types.ObjectId(actorId), session);
          // US-09-TC01: 201 MemberDto, version 0, chưa có accountId.
          return { status: 201, body: { ...toMemberResponse(member) }, resultIds: { memberId: member._id } };
        } catch (error) {
          // US-09-TC05: hai request cùng lúc đều qua bước kiểm tra trên; unique index phone chặn request sau.
          if (isDuplicatePhone(error)) throw phoneExists();
          throw error;
        }
      },
    );
  }
}

// US-09-F02: họ tên 2–120 ký tự, phone chuẩn hóa EN01-D01, ngày sinh hợp lệ không ở tương lai, địa chỉ ≤ 255.
// Dùng các hàm chuẩn hóa chung trong common/utils/normalization.ts để cùng một luật ở mọi nơi.
function normalizeInput(dto: CreateMemberDto): NewMemberInput {
  return {
    fullName: normalizeFullName(dto.fullName),
    phone: normalizePhone(dto.phone),
    birthDate: dto.birthDate === undefined ? undefined : normalizeBirthDate(dto.birthDate) ?? undefined,
    address: dto.address === undefined ? undefined : normalizeAddress(dto.address) ?? undefined,
  };
}

function phoneExists(): ApplicationError {
  return new ApplicationError(409, 'MEMBER_PHONE_EXISTS', 'Số điện thoại đã có hồ sơ hội viên');
}
