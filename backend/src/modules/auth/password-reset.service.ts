// Tầng nghiệp vụ: quên mật khẩu US-05 – yêu cầu mã OTP (flow mới), gửi lại mã (resend) theo F01–F05
// và xác nhận OTP để đặt mật khẩu mới theo F06.
// Mọi trường hợp đều trả cùng một phản hồi 202 để không lộ account có tồn tại, bị khóa hay không có email.
// Thư chứa OTP chỉ được gửi SAU khi transaction đã commit và SAU khi phản hồi 202 đã sẵn sàng (bước 2).
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { ApplicationError, invalidField } from '../../common/errors/application-error';
import { PasswordService } from '../../common/security/password.service';
import { normalizeEmail, normalizePhone } from '../../common/utils/normalization';
import { Account } from '../users/schemas/account.schema';
import { UsersRepository } from '../users/users.repository';
import { PasswordResetLimiter } from './password-reset-limiter.service';
import { PasswordResetMailer } from './password-reset-mailer.service';
import { PasswordResetsRepository } from './password-resets.repository';
import { PasswordReset } from './schemas/password-reset.schema';

const PUBLIC_MESSAGE = 'Nếu tài khoản đủ điều kiện, mã xác thực sẽ được gửi đến email đã lưu';
const SUCCESS_MESSAGE = 'Đã cập nhật mật khẩu, vui lòng đăng nhập lại';
const MAX_ATTEMPTS = 5;
const CODE_LIFETIME_MS = 10 * 60 * 1000;
const COOLDOWN_MS = 60 * 1000;
// US-05-F03: thời gian phản hồi tối thiểu, lớn hơn nhiều so với thời gian chạy transaction (khoảng 20–30 ms khi đo).
const MIN_RESPONSE_MS = 200;

export interface PasswordResetRequestResult { message: string; challenge: string }
// OTP thô và email nhận thư: chỉ giữ tạm trong bộ nhớ để gửi thư, không lưu DB, không ghi log (US-05-F05).
interface CodeDelivery { email: string; otp: string }

@Injectable()
export class PasswordResetService {
  constructor(private readonly users: UsersRepository, private readonly resets: PasswordResetsRepository,
    private readonly limiter: PasswordResetLimiter, private readonly mailer: PasswordResetMailer,
    private readonly passwords: PasswordService, private readonly config: ConfigService) {}

  async request(identifier: string, challenge: string | undefined, ip: string): Promise<PasswordResetRequestResult> {
    const startedAt = Date.now();
    const pepper = this.availablePepper();
    const lookup = this.normalizeIdentifier(identifier);
    await this.limiter.consumeRequestIp(ip);

    // US-05-F05: có gửi challenge thì luôn trả lại đúng challenge đó; không có thì tạo challenge ngẫu nhiên mới.
    // Account không đủ điều kiện cũng nhận challenge ngẫu nhiên này, nên phản hồi giống hệt (US-05-TC02).
    const response = { message: PUBLIC_MESSAGE, challenge: challenge ?? randomBytes(32).toString('base64url') };

    // US-05-TC03: quá 3 lần/định danh/10 phút thì vẫn 202 chung nhưng không tạo mã.
    let delivery: CodeDelivery | undefined;
    if (await this.limiter.consumeIdentifier(`${lookup.field}:${lookup.value}`)) {
      const account = lookup.field === 'phone' ? await this.users.findAccountByPhone(lookup.value) : await this.users.findAccountByEmail(lookup.value);
      if (account && isEligible(account)) {
        delivery = challenge ? await this.resend(account._id, challenge, pepper) : await this.startFlow(account._id, response.challenge, pepper);
      }
    }

    // US-05-F03: account hợp lệ phải chạy transaction nên chậm hơn. Mọi phản hồi 202 đều chờ cho đủ MIN_RESPONSE_MS
    // tính từ lúc nhận request, để thời gian phản hồi không cho biết account có tồn tại hay không.
    await waitUntil(startedAt + MIN_RESPONSE_MS);

    // US-05-TC14: KHÔNG await việc gửi thư, nên SMTP chậm hay lỗi cũng không làm chậm hay đổi phản hồi 202.
    // sendResetCode tự bắt lỗi và ghi log an toàn. Không có delivery (cooldown, vượt giới hạn, không đủ điều kiện) thì không gửi.
    if (delivery) void this.mailer.sendResetCode(delivery.email, delivery.otp);
    return response;
  }

  // US-05-F05: flow mới tăng recovery_revision (flow cũ mất hiệu lực vì revision không còn khớp) và tạo record mới.
  // Trả về thư cần gửi, hoặc undefined nếu không tạo mã (transaction không đổi gì).
  private startFlow(accountId: Types.ObjectId, challenge: string, pepper: string): Promise<CodeDelivery | undefined> {
    const otp = newOtp();
    return this.resets.inTransaction(async session => {
      const now = new Date();
      // Đọc lại trong transaction: account có thể vừa bị khóa, đổi email hoặc vừa có yêu cầu khác được chấp nhận.
      const account = await this.users.findAccountInSession(accountId, session);
      if (!account || !isEligible(account) || inCooldown(account, now)) return undefined;

      const revision = (account.recovery_revision ?? 0) + 1;
      await this.users.startRecovery(accountId, revision, now, session);
      await this.resets.create({
        accountId, tokenHash: tokenHash(pepper, challenge, otp), challengeHash: hashChallenge(challenge),
        authVersion: account.auth_version, recoveryRevision: revision, email: account.email!,
        createdAt: now, expiresAt: new Date(now.getTime() + CODE_LIFETIME_MS),
      }, session);
      // Gửi tới email đọc trong transaction (email đã lưu), không phải dữ liệu request gửi lên (US-05-F01).
      return { email: account.email!, otp };
    });
  }

  // US-05-F05: resend giữ challenge và record, thay mã mới. Challenge không hợp lệ thì không đổi gì (vẫn 202 chung).
  private resend(accountId: Types.ObjectId, challenge: string, pepper: string): Promise<CodeDelivery | undefined> {
    const otp = newOtp();
    return this.resets.inTransaction(async session => {
      const now = new Date();
      const account = await this.users.findAccountInSession(accountId, session);
      // Cooldown chưa đủ thì giữ nguyên mã đang còn hiệu lực.
      if (!account || !isEligible(account) || inCooldown(account, now)) return undefined;

      const reset = await this.resets.findByChallengeHash(hashChallenge(challenge), session);
      // Không có record, record của account khác, đã dùng, đã vô hiệu hóa, đã bị flow mới thay
      // (revision khác) hoặc password/identity đã đổi (auth_version khác) thì không gửi lại được, cần bắt đầu flow mới.
      if (!reset || !reset.account_id.equals(account._id) || reset.used_at || reset.invalidated_at ||
        reset.recovery_revision_snapshot !== account.recovery_revision || reset.auth_version_snapshot !== account.auth_version) return undefined;

      const revision = (account.recovery_revision ?? 0) + 1;
      await this.users.startRecovery(accountId, revision, now, session);
      await this.resets.replaceCode(reset._id, {
        tokenHash: tokenHash(pepper, challenge, otp), authVersion: account.auth_version, recoveryRevision: revision,
        email: account.email!, expiresAt: new Date(now.getTime() + CODE_LIFETIME_MS),
      }, session);
      return { email: account.email!, otp };
    });
  }

  // US-05-F06: xác nhận OTP và đặt mật khẩu mới. Mọi lý do mã không dùng được đều trả cùng 400 RESET_INVALID.
  async confirm(challenge: string, otp: string, newPassword: string, ip: string): Promise<{ message: string }> {
    const pepper = this.availablePepper();
    // US-05-TC15: mật khẩu sai policy thì 400 VALIDATION_ERROR ngay, chưa tốn lượt thử. Không trim, không cấm khoảng trắng.
    this.passwords.validate(newPassword, 'newPassword');
    await this.limiter.consumeConfirmIp(ip);

    // Bước 1 – kiểm mã sơ bộ ngoài transaction.
    const reset = await this.resets.findByChallengeHash(hashChallenge(challenge));
    if (!reset || !isUsable(reset, new Date())) throw resetInvalid();
    if (!otpMatches(reset.token_hash, pepper, challenge, otp)) {
      // US-05-TC06: OTP sai thì tăng attempts và commit TRƯỚC khi trả 400; lần sai thứ 5 vô hiệu hóa challenge.
      const attempts = await this.resets.recordWrongAttempt(reset._id, MAX_ATTEMPTS);
      if (attempts === MAX_ATTEMPTS) await this.resets.invalidate(reset._id, new Date());
      throw resetInvalid();
    }

    // Bước 2 – hash mật khẩu mới NGOÀI transaction, vì argon2 chậm mà transaction cần ngắn.
    let passwordHash: string;
    try {
      passwordHash = await this.passwords.hash(newPassword);
    } catch {
      throw new ApplicationError(503, 'SERVICE_UNAVAILABLE', 'Dịch vụ chưa sẵn sàng, vui lòng thử lại');
    }

    // Bước 3 – trong transaction kiểm lại mọi điều kiện rồi ghi used_at và mật khẩu mới cùng một lần commit.
    // Hai confirm đồng thời, hay confirm chạy cùng resend/US-67, cùng ghi một document nên MongoDB chỉ cho một bên commit;
    // bên kia được chạy lại work, đọc thấy dữ liệu mới và bị từ chối (US-05-TC10, TC13).
    // Lỗi ghi (TC11) làm transaction hủy toàn bộ, không đổi mật khẩu và không ghi used_at, lỗi trả 503.
    const done = await this.resets.inTransaction(async session => {
      const now = new Date();
      const current = await this.resets.findByChallengeHash(hashChallenge(challenge), session);
      if (!current || !isUsable(current, now) || !otpMatches(current.token_hash, pepper, challenge, otp)) return false;
      const account = await this.users.findAccountInSession(current.account_id, session);
      // US-05-TC09: account bị khóa, đổi email, đổi password/phone/role (auth_version) hay đã có flow mới thì từ chối.
      if (!account || account.status !== 'ACTIVE' || account.email !== current.email_snapshot ||
        account.auth_version !== current.auth_version_snapshot || account.recovery_revision !== current.recovery_revision_snapshot) return false;

      await this.resets.markUsed(current._id, now, session);
      await this.users.resetPassword(account._id, passwordHash, now, session);
      return true;
    });
    if (!done) throw resetInvalid();
    // US-05-F03: không tự đăng nhập, không trả token.
    return { message: SUCCESS_MESSAGE };
  }

  // Thiếu RESET_OTP_PEPPER nghĩa là chức năng chưa bật: trả 503, không tạo mã không có pepper.
  // US-05-F03: MongoDB không có transaction (chạy máy đơn) cũng trả 503 cho MỌI request, trước khi tìm account,
  // nếu không thì chỉ account hợp lệ bị 503 (vì chạy transaction), còn account không tồn tại vẫn 202, lộ account.
  private availablePepper(): string {
    const pepper = this.config.get<string>('resetOtpPepper');
    if (!pepper || !this.resets.supportsTransactions()) {
      throw new ApplicationError(503, 'SERVICE_UNAVAILABLE', 'Dịch vụ chưa sẵn sàng, vui lòng thử lại');
    }
    return pepper;
  }

  // US-05-F01: có ký tự @ thì coi là email, không thì coi là số điện thoại. Sai cả hai thì 400 như nhau (US-05-TC15).
  private normalizeIdentifier(value: string): { field: 'phone' | 'email'; value: string } {
    try {
      if (value.includes('@')) {
        const email = normalizeEmail(value);
        if (email) return { field: 'email', value: email };
      } else {
        return { field: 'phone', value: normalizePhone(value) };
      }
    } catch (error) {
      if (!(error instanceof ApplicationError)) throw error;
    }
    return invalidField('identifier', 'Vui lòng nhập số điện thoại hoặc email hợp lệ');
  }
}

// US-05-F01: chỉ account ACTIVE có email đã lưu mới được gửi mã.
function isEligible(account: Account): boolean {
  return account.status === 'ACTIVE' && typeof account.email === 'string' && account.email !== '';
}

// US-05-F05: cooldown 60 giây tính theo account, nên đổi giữa phone và email cũng không lách được.
function inCooldown(account: Account, now: Date): boolean {
  return account.recovery_requested_at !== undefined && now.getTime() - account.recovery_requested_at.getTime() < COOLDOWN_MS;
}

// US-05-F06: mã còn dùng được khi chưa dùng, chưa bị vô hiệu hóa, chưa hết hạn và còn lượt thử.
// Hạn dùng tính theo expires_at, không dựa vào TTL của MongoDB (US-05-TC07).
function isUsable(reset: PasswordReset, now: Date): boolean {
  return !reset.used_at && !reset.invalidated_at && reset.expires_at.getTime() > now.getTime() && reset.attempts < MAX_ATTEMPTS;
}

// So sánh constant-time (timingSafeEqual): thời gian so sánh không cho biết mã đúng được bao nhiêu ký tự.
function otpMatches(storedHash: string, pepper: string, challenge: string, otp: string): boolean {
  const stored = Buffer.from(storedHash, 'hex');
  const actual = Buffer.from(tokenHash(pepper, challenge, otp), 'hex');
  return stored.length === actual.length && timingSafeEqual(stored, actual);
}

// Bảng API: sai mã, hết hạn, bị thay, đã dùng, cạn lượt hay challenge lạ đều cùng một lỗi, không phân biệt.
function resetInvalid(): ApplicationError {
  return new ApplicationError(400, 'RESET_INVALID', 'Mã xác thực không hợp lệ hoặc đã hết hạn');
}

function waitUntil(time: number): Promise<void> {
  const remaining = time - Date.now();
  return remaining > 0 ? new Promise(resolve => setTimeout(resolve, remaining)) : Promise.resolve();
}

// US-05-F02: OTP 6 chữ số từ bộ sinh số ngẫu nhiên an toàn, giữ số 0 ở đầu.
function newOtp(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

function hashChallenge(challenge: string): string {
  return createHash('sha256').update(challenge).digest('hex');
}

// Bảng "Lưu mã": token_hash = HMAC-SHA256(RESET_OTP_PEPPER, challenge|otp), không lưu OTP thô.
function tokenHash(pepper: string, challenge: string, otp: string): string {
  return createHmac('sha256', pepper).update(`${challenge}|${otp}`).digest('hex');
}
