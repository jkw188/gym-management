// Tầng dữ liệu: nơi duy nhất đọc/ghi collection auth_rate_limits.
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
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

  // Tăng bộ đếm bằng một lệnh atomic và trả về số đếm mới, nên nhiều instance gọi cùng lúc vẫn đếm đúng.
  async increment(key: string, bucket: number, windowStart: Date, expiresAt: Date): Promise<number> {
    const counter = await this.limits.findOneAndUpdate(
      { key, bucket },
      { $inc: { count: 1 }, $setOnInsert: { window_start: windowStart, expires_at: expiresAt } },
      { upsert: true, returnDocument: 'after' },
    ).maxTimeMS(5000).orFail().exec();
    return Number(counter.count);
  }

  async decrement(key: string, bucket: number): Promise<void> {
    await this.limits.updateOne({ key, bucket }, { $inc: { count: -1 } }).maxTimeMS(5000).exec();
  }
}
