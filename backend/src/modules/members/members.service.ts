// Tầng nghiệp vụ (US-09 bước 1–3): luật tạo hồ sơ hội viên tại quầy (chuẩn hóa dữ liệu, chống trùng phone,
// chống tạo lặp theo Idempotency-Key EN-02), tra account và liên kết hồ sơ với account có xác minh.
// Tạo hồ sơ KHÔNG tạo account, gói, giao dịch hay buổi PT (US-09-F01).
import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { ApplicationError, invalidField } from '../../common/errors/application-error';
import { normalizeAddress, normalizeBirthDate, normalizeFullName, normalizePhone, validateObjectId } from '../../common/utils/normalization';
import { IdempotencyService, WorkResult } from '../operations/idempotency.service';
import { UsersService } from '../users/users.service';
import { CreateMemberDto, LinkMemberDto } from './members.dto';
import { toMemberResponse } from './members.mapper';
import { isDuplicateAccount, isDuplicatePhone, MembersRepository } from './members.repository';
import { LinkCandidate, NewMemberInput } from './members.types';

@Injectable()
export class MembersService {
  constructor(private readonly repository: MembersRepository, private readonly idempotency: IdempotencyService,
    private readonly users: UsersService) {}

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

  // GET /api/members/link-candidates (US-09 bước 2): chỉ đọc, không ghi DB và không tự nối hồ sơ (US-09-TC08).
  async findLinkCandidates(phoneInput: string): Promise<{ items: LinkCandidate[] }> {
    // US-09-TC08: chuẩn hóa EN01-D01 rồi so khớp chính xác; số sai định dạng → 400 field phone (US-09-TC09).
    const phone = normalizePhone(phoneInput);
    const account = await this.users.findMemberLinkCandidate(phone);
    if (!account) return { items: [] };
    // US-09-TC09: đã được hồ sơ khác tham chiếu hoặc đã gắn hồ sơ PT thì vẫn hiện nhưng canLink=false.
    const linked = await this.repository.isAccountLinked(new Types.ObjectId(account.id));
    const canLink = !linked && !account.hasTrainerProfile;
    return { items: [{ id: account.id, fullName: account.fullName, phone: account.phone, canLink }] };
  }

  // POST /api/members/:id/link (US-09 bước 3): liên kết hồ sơ với account MEMBER ACTIVE sau khi nhân viên xác minh
  // trực tiếp. Mọi kiểm tra và lệnh ghi nằm trong MỘT transaction (US-09-F06).
  async link(actorId: string, memberId: string, dto: LinkMemberDto, clientKey: string) {
    // US-09-TC09: id sai định dạng hoặc ghi nhận sai độ dài thì 400 ngay, chưa mở transaction.
    validateObjectId(memberId);
    const verificationNote = normalizeVerificationNote(dto.verificationNote);
    const memberObjectId = new Types.ObjectId(memberId);
    const accountObjectId = new Types.ObjectId(dto.accountId);
    const actorObjectId = new Types.ObjectId(actorId);

    return this.idempotency.execute(
      // US-09-TC08: hash gồm id hồ sơ (targetId) và dữ liệu đã chuẩn hóa; cùng key khác ghi nhận → 409 IDEMPOTENCY_CONFLICT.
      { actorId, operation: 'MEMBER_LINK', clientKey, targetId: memberId,
        payload: { accountId: dto.accountId, version: dto.version, verificationMethod: dto.verificationMethod, verificationNote } },
      async (session): Promise<WorkResult> => {
        // US-09-F06 thứ tự khóa: (1) khóa quản trị chung với đổi role/khóa account, (2) service_revision của hồ sơ.
        await this.users.lockAccountAdministration(session);
        const member = await this.repository.bumpServiceRevision(memberObjectId, session);
        if (!member) throw new ApplicationError(404, 'MEMBER_NOT_FOUND', 'Không tìm thấy hồ sơ hội viên');

        // Kiểm lại nhân viên sau khi giữ khóa: có thể vừa bị khóa hoặc đổi vai trò.
        const actor = await this.users.findAccountForLink(actorId, session);
        if (!actor || actor.status !== 'ACTIVE') throw new ApplicationError(401, 'UNAUTHENTICATED', 'Cần đăng nhập lại');
        if (actor.roleCode !== 'STAFF' && actor.roleCode !== 'ADMIN') throw new ApplicationError(403, 'FORBIDDEN', 'Không có quyền truy cập');

        // US-09-TC08: hồ sơ đã liên kết (kể cả gửi lại bằng key khác) → 409, không ghi audit mới.
        if (member.account_id) throw new ApplicationError(409, 'MEMBER_ALREADY_LINKED', 'Hồ sơ đã được liên kết tài khoản');
        // US-09-TC09: nhân viên đang xem bản cũ của hồ sơ.
        if (member.version !== dto.version) throw memberVersionConflict();

        // US-09-TC09: account phải là MEMBER, ACTIVE và không có hồ sơ PT (US-09-F05).
        const account = await this.users.findAccountForLink(dto.accountId, session);
        if (!account || account.roleCode !== 'MEMBER' || account.status !== 'ACTIVE' || account.hasTrainerProfile) {
          throw new ApplicationError(409, 'ACCOUNT_NOT_ELIGIBLE', 'Tài khoản không đủ điều kiện liên kết');
        }
        if (await this.repository.isAccountLinked(accountObjectId, session)) throw accountAlreadyLinked();
        // US-09-TC09: phone account và hồ sơ (đều đã chuẩn hóa) phải bằng nhau tại thời điểm liên kết.
        if (account.phone !== member.phone) {
          throw new ApplicationError(409, 'IDENTITY_MISMATCH', 'Số điện thoại tài khoản và hồ sơ không khớp');
        }

        let linked;
        try {
          linked = await this.repository.setAccount(memberObjectId, dto.version, accountObjectId, actorObjectId, session);
        } catch (error) {
          // Partial unique index account_id: một account không thể gắn hai hồ sơ dù hai request chạy cùng lúc.
          if (isDuplicateAccount(error)) throw accountAlreadyLinked();
          throw error;
        }
        if (!linked) throw memberVersionConflict();

        // US-09-TC08: audit ghi cùng transaction; verified_by/verified_at lấy từ server.
        await this.repository.insertLinkEvent({
          memberId: memberObjectId, accountId: accountObjectId, verifiedBy: actorObjectId, verifiedAt: new Date(),
          verificationMethod: dto.verificationMethod, verificationNote, requestKey: `MEMBER_LINK:${actorId}:${clientKey}`,
        }, session);
        return { status: 200, body: { member: toMemberResponse(linked), linked: true }, resultIds: { memberId: memberObjectId } };
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

// US-09-F05: ghi nhận đối chiếu 10–500 ký tự sau khi bỏ khoảng trắng hai đầu.
function normalizeVerificationNote(value: string): string {
  const note = value.trim();
  if (note.length < 10 || note.length > 500) invalidField('verificationNote', 'Ghi nhận đối chiếu phải từ 10 đến 500 ký tự');
  return note;
}

function memberVersionConflict(): ApplicationError {
  return new ApplicationError(409, 'VERSION_CONFLICT', 'Hồ sơ đã thay đổi. Hãy tải lại trước khi liên kết');
}

function accountAlreadyLinked(): ApplicationError {
  return new ApplicationError(409, 'ACCOUNT_ALREADY_LINKED', 'Tài khoản đã được liên kết với hồ sơ khác');
}

function phoneExists(): ApplicationError {
  return new ApplicationError(409, 'MEMBER_PHONE_EXISTS', 'Số điện thoại đã có hồ sơ hội viên');
}
