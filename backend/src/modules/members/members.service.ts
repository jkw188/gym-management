import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { ClientSession } from 'mongodb';
import { ApplicationError, invalidField } from '../../common/errors/application-error';
import { isDuplicateKey } from '../../common/http/http-error.filter';
import { normalizeAddress, normalizeBirthDate, normalizeFullName, normalizePhone, validateObjectId } from '../../common/utils/normalization';
import { DataGuardsService } from '../../infrastructure/transaction/data-guards.service';
import { AuthPrincipal } from '../auth/auth.types';
import { IdempotencyService, transactionRequestKey } from '../operations/idempotency.service';
import { UsersService } from '../users/users.service';
import { CreateMemberDto, LinkMemberDto, UpdateMemberDto } from './members.dto';
import { Member } from './schemas/member.schema';
import { toMemberResponse } from './members.mapper';
import { MembersRepository } from './members.repository';

@Injectable()
export class MembersService {
  constructor(private readonly repository: MembersRepository, private readonly users: UsersService,
    private readonly idempotency: IdempotencyService, private readonly guards: DataGuardsService) {}

  async detail(memberId: string) {
    const id = new Types.ObjectId(validateObjectId(memberId));
    try {
      const member = await this.repository.findById(id);
      if (!member) throw new ApplicationError(404, 'MEMBER_NOT_FOUND', 'Không tìm thấy hồ sơ hội viên');
      return { member: toMemberResponse(member), entitlementSummary: null, asOf: new Date().toISOString() };
    } catch (error) { throw profileError(error); }
  }

  // A supplied transaction session belongs to the caller; its retry must rerun this entire method.
  async update(actor: AuthPrincipal, memberId: string, input: UpdateMemberDto, session?: ClientSession) {
    const id = new Types.ObjectId(validateObjectId(memberId));
    if (!['fullName', 'phone', 'birthDate', 'address'].some(field => input[field as keyof UpdateMemberDto] !== undefined)) {
      invalidField('fullName', 'Cần ít nhất một trường thông tin hồ sơ');
    }
    const values = {
      ...(input.fullName !== undefined ? { full_name: normalizeFullName(input.fullName) } : {}),
      ...(input.phone !== undefined ? { phone: normalizePhone(input.phone) } : {}),
      ...(input.birthDate !== undefined ? { birth_date: normalizeBirthDate(input.birthDate) } : {}),
      ...(input.address !== undefined ? { address: normalizeAddress(input.address) } : {}),
    };
    try {
      const member = await this.repository.findById(id, session);
      if (!member) throw new ApplicationError(404, 'MEMBER_NOT_FOUND', 'Không tìm thấy hồ sơ hội viên');
      if (Number(member.version) !== input.version) throw conflict('VERSION_CONFLICT', 'Hồ sơ đã thay đổi. Hãy tải lại và đối chiếu trước khi lưu');
      const set: Partial<Pick<Member, 'full_name' | 'phone' | 'birth_date' | 'address'>> = {};
      const unset: Partial<Record<'birth_date' | 'address', 1>> = {};
      for (const field of ['full_name', 'phone', 'birth_date', 'address'] as const) {
        const value = values[field];
        if (value === undefined) continue;
        if (value === null) {
          if ((field === 'birth_date' || field === 'address') && member[field] !== undefined) unset[field] = 1;
        } else if (member[field] !== value) set[field] = value;
      }
      const updated = await this.repository.updateProfile(id, input.version, set, unset, new Types.ObjectId(actor.id), session);
      if (!updated) throw conflict('VERSION_CONFLICT', 'Hồ sơ đã thay đổi. Hãy tải lại và đối chiếu trước khi lưu');
      return { member: toMemberResponse(updated), changed: Object.keys(set).length > 0 || Object.keys(unset).length > 0 };
    } catch (error) {
      if (duplicateField(error, 'phone')) throw conflict('MEMBER_PHONE_EXISTS', 'Số điện thoại đã có hồ sơ hội viên');
      // Preserve transient transaction labels so the caller can safely retry the complete transaction.
      if (session) throw error;
      throw profileError(error);
    }
  }

  async create(actor: AuthPrincipal, input: CreateMemberDto, clientKey: string) {
    const payload = { fullName: normalizeFullName(input.fullName), phone: normalizePhone(input.phone),
      ...(input.birthDate !== undefined ? { birthDate: normalizeBirthDate(input.birthDate)! } : {}),
      ...(input.address !== undefined ? { address: normalizeAddress(input.address) ?? undefined } : {}) };
    try {
      return await this.idempotency.execute({ actorId: actor.id, operation: 'MEMBER_CREATE', clientKey, payload }, async session => {
        await this.guards.acquire(session, { accountAdministration: true });
        await this.users.requireMemberOperator(actor, session);
        const member = await this.repository.insert(payload, new Types.ObjectId(actor.id), session);
        return { status: 201, body: { ...toMemberResponse(member) }, resultIds: { memberId: member._id } };
      });
    } catch (error) {
      if (duplicateField(error, 'phone')) throw conflict('MEMBER_PHONE_EXISTS', 'Số điện thoại đã có hồ sơ hội viên. Vui lòng tra cứu hồ sơ hiện có');
      throw infrastructureError(error);
    }
  }

  async linkCandidates(phoneInput: string) {
    const account = await this.users.findMemberLinkAccount({ phone: normalizePhone(phoneInput) });
    if (!account?.eligible) return { items: [] };
    const canLink = !account.hasTrainer && !await this.repository.isAccountLinked(account.id);
    return { items: [{ id: account.id.toHexString(), fullName: account.fullName, phone: account.phone, canLink }] };
  }

  async link(actor: AuthPrincipal, memberId: string, input: LinkMemberDto, clientKey: string) {
    const id = new Types.ObjectId(validateObjectId(memberId));
    const accountId = new Types.ObjectId(validateObjectId(input.accountId));
    const note = input.verificationNote.trim();
    if (note.length < 10 || note.length > 500) invalidField('verificationNote', 'Ghi nhận đối chiếu phải có 10–500 ký tự');
    const payload = { ...input, accountId: accountId.toHexString(), verificationNote: note };
    try {
      return await this.idempotency.execute({ actorId: actor.id, operation: 'MEMBER_LINK', clientKey,
        targetId: id.toHexString(), payload }, async session => {
        // The administration lock precedes the member guard, matching US-07/08 and EN-02.
        await this.guards.acquire(session, { accountAdministration: true, members: [id] });
        await this.users.requireMemberOperator(actor, session);
        const member = await this.repository.findById(id, session);
        if (!member) throw new ApplicationError(404, 'MEMBER_NOT_FOUND', 'Không tìm thấy hồ sơ hội viên');
        if (member.account_id) throw conflict('MEMBER_ALREADY_LINKED', 'Hồ sơ đã liên kết tài khoản');
        if (Number(member.version) !== input.version) throw conflict('VERSION_CONFLICT', 'Hồ sơ đã thay đổi. Cần đọc lại hồ sơ trước khi liên kết');
        const account = await this.users.findMemberLinkAccount({ _id: accountId }, session);
        if (!account) throw new ApplicationError(404, 'ACCOUNT_NOT_FOUND', 'Không tìm thấy tài khoản');
        if (!account.eligible || account.hasTrainer) throw conflict('ACCOUNT_NOT_ELIGIBLE', 'Tài khoản phải là MEMBER ACTIVE và chưa có hồ sơ PT');
        if (await this.repository.isAccountLinked(accountId, session)) throw conflict('ACCOUNT_ALREADY_LINKED', 'Tài khoản đã liên kết hồ sơ khác');
        if (normalizePhone(account.phone) !== normalizePhone(member.phone)) throw conflict('IDENTITY_MISMATCH', 'Số điện thoại tài khoản và hồ sơ không khớp');
        const now = new Date();
        const updated = await this.repository.link(id, input.version, accountId, new Types.ObjectId(actor.id), now, session);
        if (!updated) throw conflict('VERSION_CONFLICT', 'Hồ sơ đã thay đổi. Cần đọc lại hồ sơ');
        await this.repository.insertLinkEvent({ member_id: id, account_id: accountId,
          verified_by: new Types.ObjectId(actor.id), verified_at: now, verification_method: input.verificationMethod,
          verification_note: note, request_key: transactionRequestKey(actor.id, 'MEMBER_LINK', clientKey) }, session);
        return { status: 200, body: { member: { ...toMemberResponse(updated) }, linked: true }, resultIds: { memberId: id, accountId } };
      });
    } catch (error) {
      if (error instanceof ApplicationError && error.code === 'DATA_GUARD_NOT_READY' && !await this.repository.findById(id)) {
        throw new ApplicationError(404, 'MEMBER_NOT_FOUND', 'Không tìm thấy hồ sơ hội viên');
      }
      if (duplicateField(error, 'account_id')) throw conflict('ACCOUNT_ALREADY_LINKED', 'Tài khoản đã liên kết hồ sơ khác');
      if (duplicateField(error, 'member_id')) throw conflict('MEMBER_ALREADY_LINKED', 'Hồ sơ đã liên kết tài khoản');
      throw infrastructureError(error);
    }
  }
}

function conflict(code: string, message: string) { return new ApplicationError(409, code, message); }
function profileError(error: unknown) {
  return error instanceof ApplicationError ? error : new ApplicationError(503, 'SERVICE_UNAVAILABLE',
    'Chưa xác định được kết quả. Hãy tải lại hồ sơ để đối chiếu trước khi sửa tiếp');
}
function duplicateField(error: unknown, field: string): boolean {
  return isDuplicateKey(error) && typeof error === 'object' && error !== null && 'keyPattern' in error &&
    !!(error.keyPattern as Record<string, unknown>)?.[field];
}
function infrastructureError(error: unknown) {
  return error instanceof ApplicationError && error.code !== 'DATA_GUARD_NOT_READY' ? error : new ApplicationError(503, 'SERVICE_UNAVAILABLE',
    'Chưa xác định được kết quả. Giữ nguyên khóa yêu cầu và kiểm tra lại kết quả thao tác');
}
