// Tầng dữ liệu: nơi duy nhất đọc/ghi collection auth_rate_limits.
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { isDuplicateKey } from '../../common/http/http-error.filter';
import { AuthRateLimit } from './schemas/auth-rate-limit.schema';

@Injectable()
export class AuthRateLimitsRepository implements OnModuleInit {
  constructor(@InjectModel('AuthRateLimit') private readonly limits: Model<AuthRateLimit>, private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    if (this.config.get('nodeEnv') !== 'production') await this.limits.createIndexes();
    // Production chỉ kiểm tra index đã có, giống auth_sessions.
    const actual = await this.limits.collection.listIndexes().toArray();
    for (const [key, options] of this.limits.schema.indexes()) {
      const found = actual.some(index => JSON.stringify(index.key) === JSON.stringify(key) &&
        Boolean(index.unique) === Boolean(options.unique) && index.expireAfterSeconds === options.expireAfterSeconds);
      if (!found) throw new Error('DATABASE_INDEXES_REQUIRED: run npm run ensure-indexes');
    }
  }

  // Tăng bộ đếm và trả về số đếm mới cùng thời điểm hết khung.
  async increment(key: string, windowMs: number): Promise<{ count: number; expiresAt: Date }> {
    const now = new Date();
    // Reset khung hết hạn và tăng count trong cùng một lệnh; không xóa khung giữa hai request.
    // Không phụ thuộc TTL đã dọn hay chưa. Unique key bảo vệ upsert từ nhiều instance.
    const expired = { $lte: [{ $ifNull: ['$expires_at', now] }, now] };
    const increment = () => this.limits.findOneAndUpdate({ key }, [{ $set: {
      count: { $cond: [expired, 1, { $add: ['$count', 1] }] },
      window_start: { $cond: [expired, now, '$window_start'] },
      expires_at: { $cond: [expired, new Date(now.getTime() + windowMs), '$expires_at'] },
    } }], { upsert: true, returnDocument: 'after', updatePipeline: true }).maxTimeMS(5000).orFail().exec();
    const counter = await increment().catch(error => {
      if (!isDuplicateKey(error)) throw error;
      return increment(); // Instance khác vừa tạo key; lần này tăng trên document đã tồn tại.
    });
    return { count: Number(counter.count), expiresAt: counter.expires_at };
  }

  async decrement(key: string): Promise<void> {
    await this.limits.updateOne({ key }, { $inc: { count: -1 } }).maxTimeMS(5000).exec();
  }
}
