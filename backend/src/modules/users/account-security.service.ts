import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model } from 'mongoose';
import { ApplicationError, invalidField } from '../../common/errors/application-error';
import { TransactionRunner } from '../../infrastructure/transaction/transaction-runner';
import { ACCESS_CONTEXT, AuthPrincipal } from '../auth/auth.types';
import { AuthSession } from '../auth/schemas/auth-session.schema';
import { mapUserResponse } from './account.mapper';
import { versionConflict } from './account-errors';
import { ChangeRoleDto, ChangeSecurityResponseDto, ChangeStatusDto } from './account-security.dto';
import { Account } from './schemas/account.schema';
import { Role, RoleCode, ROLE_CODES } from './schemas/role.schema';
import { ACCOUNT_ADMINISTRATION, SecurityState } from './schemas/security-state.schema';
import { SecurityEvent } from './schemas/security-event.schema';

type Change = { status: ChangeStatusDto['status'] } | { roleCode: RoleCode };

@Injectable()
export class AccountSecurityService implements OnModuleInit {
  constructor(
    @InjectModel('Account') private readonly accounts: Model<Account>,
    @InjectModel('Role') private readonly roles: Model<Role>,
    @InjectModel('AuthSession') private readonly sessions: Model<AuthSession>,
    @InjectModel('SecurityState') private readonly state: Model<SecurityState>,
    @InjectModel('SecurityEvent') private readonly events: Model<SecurityEvent>,
    private readonly transactions: TransactionRunner,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.config.get('nodeEnv') !== 'production') await this.events.createIndexes();
    const indexes = await this.events.collection.listIndexes().toArray();
    for (const [key] of this.events.schema.indexes()) {
      if (!indexes.some(index => JSON.stringify(index.key) === JSON.stringify(key))) {
        throw new Error('DATABASE_INDEXES_REQUIRED: run npm run ensure-indexes');
      }
    }
  }

  changeStatus(actor: AuthPrincipal, id: string, input: ChangeStatusDto, requestId: string) {
    return this.change(actor, id, input.version, input.reason, { status: input.status }, requestId);
  }

  // Every role/status writer and future profile-link writer must reuse this shared lock.
  changeRole(actor: AuthPrincipal, id: string, input: ChangeRoleDto, requestId: string) {
    return this.change(actor, id, input.version, input.reason, { roleCode: input.roleCode }, requestId);
  }

  // Dùng chung cho mọi lệnh cần khóa quản trị: đổi role/khóa account (US-07, US-08) và liên kết hồ sơ (US-09-F06).
  // Phải gọi ĐẦU TIÊN trong transaction: ghi tăng security_state để mọi lệnh quản trị trên mọi instance chạy lần lượt,
  // rồi kiểm lại người thực hiện (account ACTIVE, phiên chưa thu hồi/hết hạn, auth_version khớp token, role cho phép).
  async lockAndVerifyActor(actor: AuthPrincipal, allowedRoles: RoleCode[], session: ClientSession) {
    // A real common write serializes all status/role reductions across every application instance.
    const lock = await this.state.updateOne({ _id: ACCOUNT_ADMINISTRATION }, { $inc: { revision: 1n } }, { session }).exec();
    if (lock.matchedCount !== 1) throw new ApplicationError(503, 'SECURITY_STATE_NOT_READY', 'Chưa khởi tạo bảo vệ tài khoản. Cần chạy ensure-indexes');
    const context = actor[ACCESS_CONTEXT];
    if (!context || context.expiresAt * 1000 <= Date.now()) throw new ApplicationError(401, 'UNAUTHENTICATED', 'Cần đăng nhập lại');
    const currentActor = await this.accounts.findById(actor.id).session(session).exec();
    const currentSession = await this.sessions.findById(context.sessionId).session(session).exec();
    if (!currentActor || currentActor.status !== 'ACTIVE' || Number(currentActor.auth_version) !== context.authVersion ||
      !currentSession || !currentSession.account_id.equals(currentActor._id) || currentSession.revoked_at ||
      currentSession.expires_at.getTime() <= Date.now() || Number(currentSession.auth_version) !== context.authVersion) {
      throw new ApplicationError(401, 'UNAUTHENTICATED', 'Cần đăng nhập lại');
    }
    const actorRole = await this.roles.findById(currentActor.role_id).session(session).exec();
    if (!actorRole || !allowedRoles.includes(actorRole.code)) throw new ApplicationError(403, 'FORBIDDEN', 'Không có quyền truy cập');
    return currentActor;
  }

  private async change(actor: AuthPrincipal, id: string, version: number, reason: string, change: Change, requestId: string): Promise<ChangeSecurityResponseDto> {
    if (!/^[a-f\d]{24}$/i.test(id)) throw new ApplicationError(400, 'INVALID_ID', 'ID tài khoản không hợp lệ');
    if (!Number.isInteger(version) || version < 0 || version > 2147483647) invalidField('version', 'Version không hợp lệ');
    if (typeof reason !== 'string' || reason.trim().length < 10 || reason.trim().length > 500) invalidField('reason', 'Lý do phải có 10–500 ký tự');
    if ('status' in change ? !['ACTIVE', 'LOCKED'].includes(change.status) : !ROLE_CODES.includes(change.roleCode)) invalidField('fields', 'Trạng thái hoặc vai trò không hợp lệ');
    try {
      return await this.transactions.run(async session => {
        const currentActor = await this.lockAndVerifyActor(actor, ['ADMIN'], session);
        const target = await this.accounts.findById(id).session(session).exec();
        if (!target) throw new ApplicationError(404, 'USER_NOT_FOUND', 'Không tìm thấy tài khoản');
        if (Number(target.version) !== version) throw versionConflict();
        const oldRole = await this.roles.findById(target.role_id).session(session).exec();
        const nextRole = 'roleCode' in change ? await this.roles.findOne({ code: change.roleCode }).session(session).exec() : oldRole;
        if (!oldRole) throw new ApplicationError(503, 'SERVICE_UNAVAILABLE', 'Vai trò hiện tại chưa được cấu hình');
        if (!nextRole) throw new ApplicationError(409, 'ROLE_NOT_CONFIGURED', 'Vai trò đích chưa được cấu hình, cần kiểm tra seed');
        const changed = 'status' in change ? target.status !== change.status : oldRole.code !== nextRole.code;
        if (!changed) return { user: mapUserResponse(target, oldRole), changed: false, reauthenticationRequired: false };
        if ('roleCode' in change) {
          // S01 has no profile-link API. Future US-09/23 writers must take this same lock
          // and transaction, otherwise checking a profile alone cannot prevent a race.
          for (const collection of ['members', 'trainers']) {
            const profile = await this.accounts.db.collection(collection).findOne({ account_id: target._id }, { session, projection: { _id: 1 } });
            if (profile) throw new ApplicationError(409, 'ROLE_IN_USE', 'Tài khoản có hồ sơ hội viên hoặc PT liên kết. Cần xử lý hồ sơ qua module quản trị trước khi đổi vai trò');
          }
        }
        const losesActiveAdmin = oldRole.code === 'ADMIN' && target.status === 'ACTIVE' &&
          ('status' in change ? change.status === 'LOCKED' : nextRole.code !== 'ADMIN');
        if (losesActiveAdmin && await this.accounts.countDocuments({ role_id: oldRole._id, status: 'ACTIVE' }).session(session).exec() <= 1) {
          throw new ApplicationError(409, 'LAST_ACTIVE_ADMIN', 'Không thể khóa hoặc hạ vai trò Admin hoạt động cuối cùng');
        }
        const updated = await this.accounts.findOneAndUpdate({ _id: target._id, version }, {
          $set: 'status' in change ? { status: change.status } : { role_id: nextRole._id },
          $inc: { version: 1, auth_version: 1 },
        }, { session, returnDocument: 'after', runValidators: true }).exec();
        if (!updated) throw versionConflict();
        await this.events.create([{
          actor_id: currentActor._id, target_id: target._id,
          action: 'status' in change ? change.status === 'LOCKED' ? 'LOCK' : 'UNLOCK' : 'CHANGE_ROLE',
          before: 'status' in change ? { status: target.status } : { roleCode: oldRole.code },
          after: 'status' in change ? { status: change.status } : { roleCode: nextRole.code },
          reason: reason.trim(), request_id: requestId,
        }], { session });
        return { user: mapUserResponse(updated, nextRole), changed: true, reauthenticationRequired: target._id.equals(currentActor._id) };
      });
    } catch (error) {
      if (error instanceof ApplicationError && error.code !== 'OPERATION_OUTCOME_UNKNOWN') throw error;
      // A deadline/unknown commit can have committed: the UI must GET before deciding to repeat.
      throw new ApplicationError(503, 'SERVICE_UNAVAILABLE', 'Chưa xác định được kết quả thao tác. Hãy tải lại trạng thái trước khi thử lại');
    }
  }
}
