import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession } from 'mongodb';
import { Model, Types } from 'mongoose';
import { Member } from './schemas/member.schema';
import { MemberLinkEvent } from './schemas/member-link-event.schema';

@Injectable()
export class MembersRepository implements OnModuleInit {
  constructor(@InjectModel('Member') private readonly members: Model<Member>,
    @InjectModel('MemberLinkEvent') private readonly events: Model<MemberLinkEvent>, private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    for (const model of [this.members, this.events]) {
      if (this.config.get('nodeEnv') !== 'production') await model.createIndexes();
      const indexes = await model.collection.listIndexes().toArray();
      for (const [key, options] of model.schema.indexes()) {
        if (!indexes.some(index => JSON.stringify(index.key) === JSON.stringify(key) &&
          !!index.unique === !!options.unique && !index.sparse && index.expireAfterSeconds === undefined &&
          (!index.collation || index.collation.locale === 'simple') &&
          JSON.stringify(index.partialFilterExpression) === JSON.stringify(options.partialFilterExpression))) {
          throw new Error('DATABASE_INDEXES_REQUIRED: run npm run ensure-indexes');
        }
      }
    }
  }

  findById(id: Types.ObjectId, session?: ClientSession) {
    return this.members.findById(id).session(session ?? null).maxTimeMS(5000).lean().exec();
  }
  async isAccountLinked(accountId: Types.ObjectId, session?: ClientSession): Promise<boolean> {
    return !!await this.members.exists({ account_id: accountId }).session(session ?? null).exec();
  }
  async insert(input: { fullName: string; phone: string; birthDate?: string; address?: string }, actorId: Types.ObjectId, session: ClientSession) {
    const id = new Types.ObjectId();
    const [member] = await this.members.create([{ _id: id, id, member_code: `HV-${id.toHexString()}`,
      full_name: input.fullName, phone: input.phone, birth_date: input.birthDate, address: input.address,
      created_by: actorId, updated_by: actorId, service_revision: 0n, version: 0 }], { session });
    return member.toObject();
  }
  link(id: Types.ObjectId, version: number, accountId: Types.ObjectId, actorId: Types.ObjectId, now: Date, session: ClientSession) {
    return this.members.findOneAndUpdate({ _id: id, version, account_id: { $exists: false } },
      { $set: { account_id: accountId, updated_by: actorId, updated_at: now }, $inc: { version: 1 } },
      { session, returnDocument: 'after', timestamps: false, runValidators: true }).lean().exec();
  }
  async insertLinkEvent(input: Omit<MemberLinkEvent, '_id'>, session: ClientSession): Promise<void> {
    await this.events.create([input], { session });
  }
}
