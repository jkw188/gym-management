// Tầng dữ liệu: nơi duy nhất đọc/ghi collection password_resets (US-05), và mở transaction cho flow quên mật khẩu.
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import { PasswordReset } from './schemas/password-reset.schema';

export interface NewPasswordReset {
  accountId: Types.ObjectId; tokenHash: string; challengeHash: string; authVersion: number; recoveryRevision: number;
  email: string; createdAt: Date; expiresAt: Date;
}
export interface ReplacedCode {
  tokenHash: string; authVersion: number; recoveryRevision: number; email: string; expiresAt: Date;
}

@Injectable()
export class PasswordResetsRepository implements OnModuleInit {
  private transactionsSupported = false;
  constructor(@InjectModel('PasswordReset') private readonly resets: Model<PasswordReset>,
    @InjectConnection() private readonly connection: Connection, private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    // MongoDB chỉ có transaction khi chạy replica set (có setName) hoặc qua mongos (msg = 'isdbgrid').
    const hello = await this.connection.db!.admin().command({ hello: 1 });
    this.transactionsSupported = typeof hello.setName === 'string' || hello.msg === 'isdbgrid';
    if (!this.transactionsSupported && this.config.get('resetOtpPepper')) {
      console.warn(JSON.stringify({ timestamp: new Date().toISOString(), code: 'PASSWORD_RESET_DISABLED_NO_TRANSACTIONS' }));
    }
    if (this.config.get('nodeEnv') !== 'production') await this.resets.createIndexes();
    // Production chỉ kiểm tra index đã có, giống auth_rate_limits.
    const actual = await this.resets.collection.listIndexes().toArray();
    for (const [key, options] of this.resets.schema.indexes()) {
      const found = actual.some(index => JSON.stringify(index.key) === JSON.stringify(key) &&
        Boolean(index.unique) === Boolean(options.unique) && index.expireAfterSeconds === options.expireAfterSeconds);
      if (!found) throw new Error('DATABASE_INDEXES_REQUIRED: run npm run ensure-indexes');
    }
  }

  // US-05-F03: service dùng hàm này để từ chối MỌI request khi DB không có transaction, không riêng account hợp lệ.
  supportsTransactions(): boolean {
    return this.transactionsSupported;
  }

  // US-05-F05: chạy work trong một transaction. Mongoose tự chạy lại work khi hai transaction ghi trùng một document,
  // nên work không được gửi email hay làm việc gì không lặp lại được.
  inTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    return this.connection.transaction(work);
  }

  // Không truyền session thì đọc ngoài transaction (bước kiểm mã sơ bộ của confirm).
  findByChallengeHash(challengeHash: string, session?: ClientSession) {
    return this.resets.findOne({ challenge_hash: challengeHash }).session(session ?? null).maxTimeMS(5000).exec();
  }

  // US-05-F06: tăng attempts bằng MỘT lệnh atomic và commit ngay (không nằm trong transaction) để không bị rollback.
  // Chỉ tăng khi record còn dùng được và attempts < maxAttempts, nên nhiều request sai đồng thời cũng không vượt quá.
  // Trả về số lần thử mới, hoặc null nếu không tăng được (record đã dùng, đã vô hiệu hóa hoặc đã đủ lượt).
  async recordWrongAttempt(id: Types.ObjectId, maxAttempts: number): Promise<number | null> {
    const updated = await this.resets.findOneAndUpdate(
      { _id: id, used_at: { $exists: false }, invalidated_at: { $exists: false }, attempts: { $lt: maxAttempts } },
      { $inc: { attempts: 1 } }, { returnDocument: 'after' },
    ).maxTimeMS(5000).exec();
    return updated ? updated.attempts : null;
  }

  // US-05-TC06: lần sai cuối cùng thì vô hiệu hóa challenge.
  async invalidate(id: Types.ObjectId, invalidatedAt: Date): Promise<void> {
    await this.resets.updateOne({ _id: id, invalidated_at: { $exists: false } }, { $set: { invalidated_at: invalidatedAt } })
      .maxTimeMS(5000).exec();
  }

  // US-05-F06: OTP đúng thì ghi used_at và attempts+1, cùng transaction với việc đổi mật khẩu.
  async markUsed(id: Types.ObjectId, usedAt: Date, session: ClientSession): Promise<void> {
    await this.resets.updateOne({ _id: id, used_at: { $exists: false } }, { $set: { used_at: usedAt }, $inc: { attempts: 1 } },
      { session, runValidators: true }).exec();
  }

  async create(input: NewPasswordReset, session: ClientSession): Promise<void> {
    await this.resets.create([{
      account_id: input.accountId, token_hash: input.tokenHash, challenge_hash: input.challengeHash, attempts: 0,
      auth_version_snapshot: input.authVersion, recovery_revision_snapshot: input.recoveryRevision,
      email_snapshot: input.email, created_at: input.createdAt, expires_at: input.expiresAt,
    }], { session });
  }

  // US-05-F05: resend giữ nguyên record và challenge, chỉ thay mã, snapshot, hạn dùng và đặt lại số lần thử.
  async replaceCode(id: Types.ObjectId, changes: ReplacedCode, session: ClientSession): Promise<void> {
    await this.resets.updateOne({ _id: id }, { $set: {
      token_hash: changes.tokenHash, auth_version_snapshot: changes.authVersion, recovery_revision_snapshot: changes.recoveryRevision,
      email_snapshot: changes.email, expires_at: changes.expiresAt, attempts: 0,
    } }, { session, runValidators: true }).exec();
  }
}
