import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AuthSession } from './schemas/auth-session.schema';

@Injectable()
export class AuthSessionsRepository implements OnModuleInit {
  constructor(@InjectModel('AuthSession') private readonly sessions: Model<AuthSession>, private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    if (this.config.get('nodeEnv') !== 'production') await this.sessions.createIndexes();
    const actual = await this.sessions.collection.listIndexes().toArray();
    for (const [key, options] of this.sessions.schema.indexes()) {
      if (!actual.some(index => JSON.stringify(index.key) === JSON.stringify(key) &&
        Boolean(index.unique) === Boolean(options.unique) && index.expireAfterSeconds === options.expireAfterSeconds)) {
        throw new Error('DATABASE_INDEXES_REQUIRED: run npm run ensure-indexes');
      }
    }
  }

  create(accountId: string, authVersion: number, refreshHash: string, expiresAt: Date) {
    return this.sessions.create({ account_id: new Types.ObjectId(accountId), auth_version: authVersion, refresh_hash: refreshHash, expires_at: expiresAt });
  }
  findById(id: string) { return this.sessions.findOne({ id: new Types.ObjectId(id) }).exec(); }
  findByHash(hash: string) { return this.sessions.findOne({ refresh_hash: hash }).exec(); }
  rotate(session: AuthSession, previousHash: string, nextHash: string) {
    // The old verifier and validity predicates are part of the write: only one concurrent request wins.
    return this.sessions.findOneAndUpdate({ _id: session._id, refresh_hash: previousHash, revoked_at: null,
      expires_at: { $gt: new Date() }, auth_version: session.auth_version },
    { $set: { refresh_hash: nextHash } }, { returnDocument: 'after', runValidators: true }).exec();
  }
}
